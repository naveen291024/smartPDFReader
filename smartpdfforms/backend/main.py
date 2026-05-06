"""
FastAPI OCR backend for SmartPDFForms
--------------------------------------
Replaces in-browser Tesseract.js with server-side HuggingFace TrOCR.

Pipeline:
  PDF upload → pdf2image → EasyOCR (bbox detection) → TrOCR (text recognition)
             → RawTextItem[] + PageDimensions[] → JSON

EasyOCR detects bounding boxes for each text region.
TrOCR (microsoft/trocr-large-printed + trocr-large-handwritten) reads the text
from each cropped region with higher accuracy than Tesseract.

Usage:
  cd backend
  uvicorn main:app --reload --port 8000
"""

import io
import logging
import os
import traceback
from typing import Optional

import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageEnhance, ImageFilter
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
HF_PRINTED_MODEL     = os.getenv("HF_PRINTED_MODEL",     "microsoft/trocr-base-printed")
HF_HANDWRITTEN_MODEL = os.getenv("HF_HANDWRITTEN_MODEL", "microsoft/trocr-base-handwritten")
PDF_DPI              = int(os.getenv("PDF_DPI", "300"))
USE_GPU              = torch.cuda.is_available()
DEVICE               = "cuda" if USE_GPU else "cpu"

# Confidence threshold: regions with EasyOCR confidence below this use the
# handwritten model; above it use the printed model
HW_CONFIDENCE_THRESHOLD = 0.75

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="SmartPDFForms OCR Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def preload_models():
    """Pre-load EasyOCR at startup. TrOCR is loaded lazily (optional enhancement)."""
    import asyncio
    loop = asyncio.get_event_loop()
    logger.info("[startup] Pre-loading EasyOCR reader…")
    await loop.run_in_executor(None, get_easy_reader)
    logger.info("[startup] EasyOCR ready. TrOCR will load on first use (if available).")

# ── Pydantic response models ──────────────────────────────────────────────────
class RawTextItem(BaseModel):
    """Matches TypeScript RawTextItem in pdfExtractor.ts"""
    text: str
    x: float        # points from left
    y: float        # points from top (pageHeight - bbox_top)
    width: float
    height: float
    page: int
    confidence: float = 1.0  # EasyOCR confidence 0-1; low = likely handwritten

class PageDimensions(BaseModel):
    page: int
    width: float
    height: float

class OCRResponse(BaseModel):
    items: list[RawTextItem]
    pages: list[PageDimensions]
    usedOCR: bool = True
    modelInfo: dict


# ── Lazy-loaded models (loaded once on first request) ─────────────────────────
_printed_processor = None
_printed_model     = None
_hw_processor      = None
_hw_model          = None
_easy_reader       = None
_models_load_failed: set[str] = set()  # track permanently failed models to skip retries


def get_easy_reader():
    global _easy_reader
    if _easy_reader is None:
        import easyocr
        logger.info("Loading EasyOCR reader…")
        _easy_reader = easyocr.Reader(["en"], gpu=USE_GPU)
        logger.info("EasyOCR ready.")
    return _easy_reader


def get_printed_model():
    global _printed_processor, _printed_model
    if _printed_model is None and "printed" not in _models_load_failed:
        from transformers import TrOCRProcessor, VisionEncoderDecoderModel
        logger.info(f"Loading TrOCR printed model: {HF_PRINTED_MODEL}")
        try:
            _printed_processor = TrOCRProcessor.from_pretrained(HF_PRINTED_MODEL)
            _printed_model = VisionEncoderDecoderModel.from_pretrained(
                HF_PRINTED_MODEL
            ).to(DEVICE)
            logger.info("TrOCR printed model ready.")
        except Exception as e:
            logger.error(f"Failed to load printed model '{HF_PRINTED_MODEL}': {e}")
            _models_load_failed.add("printed")
            return None, None
    return _printed_processor, _printed_model


def get_hw_model():
    global _hw_processor, _hw_model
    if _hw_model is None and "handwritten" not in _models_load_failed:
        from transformers import TrOCRProcessor, VisionEncoderDecoderModel
        logger.info(f"Loading TrOCR handwritten model: {HF_HANDWRITTEN_MODEL}")
        try:
            _hw_processor = TrOCRProcessor.from_pretrained(HF_HANDWRITTEN_MODEL)
            _hw_model = VisionEncoderDecoderModel.from_pretrained(
                HF_HANDWRITTEN_MODEL
            ).to(DEVICE)
            logger.info("TrOCR handwritten model ready.")
        except Exception as e:
            logger.error(f"Failed to load handwritten model '{HF_HANDWRITTEN_MODEL}': {e}")
            _models_load_failed.add("handwritten")
            return None, None
    return _hw_processor, _hw_model


# ── Image preprocessing ───────────────────────────────────────────────────────
def preprocess(image: Image.Image, mode: str = "printed") -> Image.Image:
    image = image.convert("RGB")
    if mode == "printed":
        image = ImageEnhance.Contrast(image).enhance(2.0)
        image = ImageEnhance.Sharpness(image).enhance(2.5)
        image = image.filter(ImageFilter.SHARPEN)
    else:
        image = ImageEnhance.Contrast(image).enhance(1.8)
        image = ImageEnhance.Brightness(image).enhance(1.1)
        image = image.filter(ImageFilter.SMOOTH)
    return image


def preprocess_for_handwriting(image: Image.Image) -> Image.Image:
    """
    Enhance a full page image to make blue ballpoint handwriting more visible.
    Steps:
      1. Convert to grayscale
      2. CLAHE-style contrast boost via histogram normalisation (Pillow-only)
      3. Sharpen edges so thin strokes are crisper
      4. Slightly darken so blue ink competes with printed lines
    """
    import numpy as np
    gray = image.convert("L")
    arr = np.array(gray, dtype=np.float32)
    # Stretch histogram to full 0-255 range
    lo, hi = arr.min(), arr.max()
    if hi > lo:
        arr = (arr - lo) / (hi - lo) * 255.0
    # Gamma < 1 boosts midtones (brings up faint ink)
    arr = 255.0 * (arr / 255.0) ** 0.7
    enhanced_gray = Image.fromarray(arr.astype(np.uint8), mode="L")
    # Back to RGB for EasyOCR
    enhanced = enhanced_gray.convert("RGB")
    enhanced = ImageEnhance.Contrast(enhanced).enhance(2.2)
    enhanced = ImageEnhance.Sharpness(enhanced).enhance(3.0)
    return enhanced


# ── TrOCR inference ───────────────────────────────────────────────────────────
def run_trocr(crop: Image.Image, mode: str = "printed") -> str:
    """Run TrOCR on a cropped PIL image region."""
    try:
        if mode == "handwritten":
            processor, model = get_hw_model()
        else:
            processor, model = get_printed_model()

        if processor is None or model is None:
            return ""  # model failed to load — skip silently, fall back to EasyOCR text

        enhanced = preprocess(crop, mode)
        pixel_values = processor(
            images=enhanced, return_tensors="pt"
        ).pixel_values.to(DEVICE)

        generated_ids = model.generate(
            pixel_values,
            max_new_tokens=100,
            num_beams=4,
            early_stopping=True,
        )
        text = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        return text.strip()
    except Exception as e:
        logger.warning(f"TrOCR inference failed: {e}")
        return ""


# ── Core OCR function ─────────────────────────────────────────────────────────
def _easyocr_results_to_items(
    results: list,
    page_image: Image.Image,
    page_num: int,
    scale: float,
    trocr_available_printed: bool,
    trocr_available_hw: bool,
    seen_boxes: set,
) -> list["RawTextItem"]:
    """Convert raw EasyOCR results to RawTextItem list, deduplicating by box coord."""
    import numpy as np
    items: list[RawTextItem] = []
    for bbox_points, easy_text, confidence in results:
        xs = [p[0] for p in bbox_points]
        ys = [p[1] for p in bbox_points]
        x1, y1 = int(min(xs)), int(min(ys))
        x2, y2 = int(max(xs)), int(max(ys))

        if x2 - x1 < 3 or y2 - y1 < 3:
            continue

        # Deduplicate: skip if we already have a box within 10px of this one
        box_key = (round(x1 / 10), round(y1 / 10))
        if box_key in seen_boxes:
            continue
        seen_boxes.add(box_key)

        crop = page_image.crop((x1, y1, x2, y2))
        ocr_mode = "handwritten" if confidence < HW_CONFIDENCE_THRESHOLD else "printed"
        trocr_available = (
            (ocr_mode == "printed" and trocr_available_printed) or
            (ocr_mode == "handwritten" and trocr_available_hw)
        )
        refined_text = run_trocr(crop, mode=ocr_mode) if trocr_available else ""
        final_text = refined_text if refined_text else easy_text
        if not final_text.strip():
            continue

        items.append(RawTextItem(
            text=final_text,
            x=round(x1 / scale, 2),
            y=round(y1 / scale, 2),
            width=round((x2 - x1) / scale, 2),
            height=round((y2 - y1) / scale, 2),
            page=page_num,
            confidence=round(float(confidence), 3),
        ))
    return items


def ocr_page(
    page_image: Image.Image,
    page_num: int,
    scale: float,
) -> list["RawTextItem"]:
    """
    Two-pass EasyOCR strategy:
      Pass 1 — standard settings on the original image (printed text)
      Pass 2 — handwriting-tuned settings on a contrast-enhanced version
                (catches faint blue-ink handwritten values missed by pass 1)
    Results are deduplicated by bounding-box position.
    """
    import numpy as np
    reader = get_easy_reader()

    trocr_available_printed  = "printed"     not in _models_load_failed
    trocr_available_hw       = "handwritten" not in _models_load_failed

    seen_boxes: set = set()
    all_items: list[RawTextItem] = []

    # ── Pass 1: standard (printed / high-confidence text) ─────────────────────
    img_arr_std = np.array(page_image)
    results_std = reader.readtext(
        img_arr_std,
        detail=1,
        paragraph=False,
        text_threshold=0.5,
        low_text=0.3,
        link_threshold=0.3,
        contrast_ths=0.05,
        adjust_contrast=0.6,
        mag_ratio=1.2,
        slope_ths=0.3,
        width_ths=0.7,
    )
    items_std = _easyocr_results_to_items(
        results_std, page_image, page_num, scale,
        trocr_available_printed, trocr_available_hw, seen_boxes
    )
    all_items.extend(items_std)
    logger.info(f"  Pass 1 (standard):     {len(items_std)} items")

    # ── Pass 2: handwriting-optimised (lower thresholds + enhanced image) ─────
    hw_image = preprocess_for_handwriting(page_image)
    img_arr_hw = np.array(hw_image)
    results_hw = reader.readtext(
        img_arr_hw,
        detail=1,
        paragraph=False,
        text_threshold=0.2,      # Much lower — catches faint handwriting
        low_text=0.15,
        link_threshold=0.15,
        contrast_ths=0.02,
        adjust_contrast=0.8,
        mag_ratio=1.5,           # Enlarge before detection
        slope_ths=0.5,           # Allow slanted cursive strokes
        width_ths=1.0,           # Merge wider boxes for connected writing
        ycenter_ths=0.7,
    )
    items_hw = _easyocr_results_to_items(
        results_hw, page_image, page_num, scale,
        trocr_available_printed, trocr_available_hw, seen_boxes
    )
    all_items.extend(items_hw)
    logger.info(f"  Pass 2 (handwriting):  {len(items_hw)} new items")

    return all_items


# ── Route ─────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": DEVICE,
        "printed_model": HF_PRINTED_MODEL,
        "handwritten_model": HF_HANDWRITTEN_MODEL,
    }


@app.post("/ocr", response_model=OCRResponse)
async def ocr_pdf(file: UploadFile = File(...)):
    """
    Accept a PDF file, run HuggingFace TrOCR OCR, return RawTextItem[] + PageDimensions[]
    matching the TypeScript interface expected by the Next.js frontend.
    """
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    try:
        from pdf2image import convert_from_bytes
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="pdf2image not installed. Run: pip install pdf2image",
        )

    pdf_bytes = await file.read()
    logger.info(f"Received PDF: {file.filename} ({len(pdf_bytes)} bytes)")

    # Convert PDF pages to PIL images at specified DPI
    try:
        pages_images = convert_from_bytes(pdf_bytes, dpi=PDF_DPI)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF conversion failed: {e}")

    logger.info(f"PDF has {len(pages_images)} page(s)")

    # Scale factor: pixels per pdf point (1 pt = 1/72 inch)
    scale = PDF_DPI / 72.0

    all_items: list[RawTextItem] = []
    page_dims: list[PageDimensions] = []

    try:
        for page_num, page_image in enumerate(pages_images, start=1):
            logger.info(f"OCR page {page_num}/{len(pages_images)}")
            w_px, h_px = page_image.size

            page_dims.append(PageDimensions(
                page=page_num,
                width=round(w_px / scale, 2),
                height=round(h_px / scale, 2),
            ))

            items = ocr_page(page_image, page_num, scale)
            all_items.extend(items)
            logger.info(f"  → {len(items)} text items on page {page_num}")
    except Exception as e:
        tb = traceback.format_exc()
        logger.error(f"OCR pipeline failed on page {page_num}:\n{tb}")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}\n\n{tb}")

    logger.info(f"Total text items extracted: {len(all_items)}")

    return OCRResponse(
        items=all_items,
        pages=page_dims,
        usedOCR=True,
        modelInfo={
            "printed": HF_PRINTED_MODEL,
            "handwritten": HF_HANDWRITTEN_MODEL,
            "device": DEVICE,
        },
    )
