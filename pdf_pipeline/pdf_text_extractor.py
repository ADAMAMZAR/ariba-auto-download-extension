"""
pdf_text_extractor.py
─────────────────────────────────────────────────────────────────────────────
Method 1: Visual Layout Text Extraction & Flattening
Part of the Automated Vendor Document Auditing Pipeline.

Purpose
-------
Intercepts incoming third-party insurance and technical PDFs, extracts their
text layer using pdfplumber's horizontal-layout engine, applies a deterministic
cleaning pass to correct known scanning / OCR artefacts, and saves the result
as a flattened UTF-8 .txt file ready for AI auditor ingestion.

Dependencies
------------
    pip install pdfplumber

Usage (CLI)
-----------
    python pdf_text_extractor.py <input.pdf> <output.txt>

Usage (API)
-----------
    from pdf_text_extractor import extract_pdf_to_text
    success = extract_pdf_to_text("vendor_cert.pdf", "vendor_cert.txt")
"""

from __future__ import annotations

import logging
import re
import sys
from pathlib import Path
from typing import Optional

import pdfplumber

# ─────────────────────────────────────────────────────────────────────────────
# Logging Configuration
# ─────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  [%(levelname)-8s]  %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("pdf_pipeline.extractor")

# ─────────────────────────────────────────────────────────────────────────────
# Constants & Sentinel Values
# ─────────────────────────────────────────────────────────────────────────────

VISUAL_EXTRACTION_BLOCKED = "[VISUAL_EXTRACTION_BLOCKED]"

# pdfplumber layout kwargs — forces left-to-right horizontal sweep so the
# engine reads across multi-column tables instead of falling straight down
# a single column.
LAYOUT_KWARGS: dict = {
    "layout": True,            # enable spatial / visual layout mode
    "layout_width_chars": 200, # wide virtual canvas avoids premature wrapping
    "x_tolerance": 3,          # horizontal character clustering tolerance (pts)
    "y_tolerance": 3,          # vertical  character clustering tolerance (pts)
    "x_density": 7.25,         # chars-per-point horizontal density factor
    "y_density": 13,           # chars-per-point vertical   density factor
}

# ─────────────────────────────────────────────────────────────────────────────
# Deterministic Cleaning Layer
# ─────────────────────────────────────────────────────────────────────────────

# ---------------------------------------------------------------------------
# Pattern Set 1 — Alphanumeric Ghosting Typos
#   Scanning firmware sometimes replaces a digit ZERO (`0`) with a capital
#   letter OH (`O`) inside structured tracking codes / serial numbers.
#
#   Strategy: match known tracking-code prefixes and replace a trailing `O`
#   (capital oh) with `0` (zero).  Patterns are intentionally strict to avoid
#   corrupting legitimate words like "MONO", "LOGO", etc.
# ---------------------------------------------------------------------------

_TRACKING_CODE_ZERO_FIX = [
    # --- Insurance / registration / VIN-style patterns --------------------
    # e.g.  "MOTN0"  scanned as  "MOTNO"  → fix trailing O → 0
    (re.compile(r"\b(MOT[A-Z]{0,3})O\b"), r"\g<1>0"),
    # e.g.  "WBA10"  scanned as  "WBA1O"  → fix trailing O → 0
    (re.compile(r"\b(WBA\d+)O\b"),        r"\g<1>0"),
    # Generic: uppercase prefix (2-5 letters) + digits + a trailing O
    # e.g.  "REF123O"  →  "REF1230"
    (re.compile(r"\b([A-Z]{2,5}\d{2,})O\b"), r"\g<1>0"),
    # Digit-heavy codes where O sits inside a numeric run
    # e.g.  "12O34" → "12034"
    (re.compile(r"(\d+)O(\d+)"), r"\g<1>0\g<2>"),
]

# ---------------------------------------------------------------------------
# Pattern Set 2 — Line-Wrap Reconstitution
#   Narrow table borders in PDFs cause legal suffixes to be ejected onto the
#   next line.  Snap them back to the preceding company-name line.
#
#   Handled suffixes (case-insensitive):
#       PTY LTD | PTY. LTD. | SDN BHD | SDN. BHD. | LTD | PTE LTD | INC
#       LLC | CORP | PLC | GmbH | B.V. | S.A. | S.L.
# ---------------------------------------------------------------------------

_LEGAL_SUFFIX_PATTERN = re.compile(
    r"(?m)"                                # multiline: ^ and $ match line edges
    r"([\w&',.\- ]+?)"                    # group 1 — company name fragment
    r"\n"                                  # the errant newline
    r"[ \t]*"                              # optional indentation on next line
    r"("
    r"(?:PTY\.?\s+LTD\.?)"               # PTY LTD / PTY. LTD.
    r"|(?:SDN\.?\s+BHD\.?)"              # SDN BHD / SDN. BHD.
    r"|(?:PTE\.?\s+LTD\.?)"              # PTE LTD
    r"|LTD\.?"                            # LTD / LTD.
    r"|INC\.?"                            # INC / INC.
    r"|LLC\.?"                            # LLC
    r"|CORP\.?"                           # CORP
    r"|PLC\.?"                            # PLC
    r"|GmbH"                              # GmbH
    r"|B\.V\."                            # B.V.
    r"|S\.A\."                            # S.A.
    r"|S\.L\."                            # S.L.
    r")"
    r"(?=\s*\n|\s*$)",                    # lookahead: suffix ends the line
    re.IGNORECASE,
)


def _fix_tracking_code_zeros(text: str) -> str:
    """Replace capital-O scanning glitches with digit-0 in tracking codes."""
    # ── Static literal replacements (fastest path, exact known glitches) ──────
    text = text.replace("MOTNO", "MOTN0")
    text = text.replace("WBA1O", "WBA10")
    # ── Regex-based patterns for generic tracking-code variants ───────────────
    for pattern, replacement in _TRACKING_CODE_ZERO_FIX:
        text = pattern.sub(replacement, text)
    return text


def _reconstitute_wrapped_legal_suffixes(text: str) -> str:
    """Snap orphaned legal entity suffixes back onto their company-name lines."""
    # We iterate in case multiple consecutive wraps exist (e.g. two fixes needed)
    previous = None
    while previous != text:
        previous = text
        text = _LEGAL_SUFFIX_PATTERN.sub(r"\1 \2", text)
    return text


def _normalize_unicode_whitespace(text: str) -> str:
    """Replace non-breaking spaces and other exotic whitespace with standard ASCII."""
    # Non-breaking space (U+00A0), en-space (U+2002), em-space (U+2003), etc.
    return re.sub(r"[\u00a0\u2000-\u200b\u202f\u205f\u3000]", " ", text)


def _collapse_horizontal_whitespace(text: str) -> str:
    """Collapse multiple consecutive spaces or tabs into a single space.

    Eliminates the visual-layout padding that pdfplumber injects when
    ``layout=True`` is used, which otherwise pushes label values far apart
    and causes downstream AI parsers to miss field associations.
    """
    return re.sub(r"[ \t]+", " ", text)


def _normalize_line_breaks(text: str) -> str:
    """Compress any run of consecutive newlines down to a single line break.

    Removes the empty structural gaps that pdfplumber's layout engine
    introduces between visual rows, which fragment multi-line values
    and break sentence continuity for AI parsers.
    """
    return re.sub(r"\n+", "\n", text)


def clean_extracted_text(raw_text: str) -> str:
    """
    Apply the full deterministic cleaning pipeline to raw extracted text.

    Order of operations is intentional and must not be changed:
        1. Unicode whitespace normalisation    — converts exotic spaces to ASCII
           (prerequisite: all subsequent steps expect standard space characters)
        2. Horizontal whitespace collapsing    — collapses layout-padding runs
           of spaces/tabs to a single space, pulling labels back next to values
        3. Tracking-code zero ghosting fix     — static literals first, then regex
           (must run before line-break normalization while codes are on one line)
        4. Legal suffix line-wrap restitution  — snaps orphaned PTY/LTD/SDN BHD
           suffixes back onto their company-name lines
           (must run BEFORE step 5 so the joining newline still exists)
        5. Line-break normalization            — collapses all consecutive newlines
           to a single '\n', removing vertical structural gaps

    Parameters
    ----------
    raw_text : str
        The raw string as returned by pdfplumber's extract_text.

    Returns
    -------
    str
        Cleaned, linear, AI-parser-ready text stream.
    """
    text = _normalize_unicode_whitespace(raw_text)   # step 1
    text = _collapse_horizontal_whitespace(text)      # step 2  ← NEW
    text = _fix_tracking_code_zeros(text)             # step 3
    text = _reconstitute_wrapped_legal_suffixes(text) # step 4
    text = _normalize_line_breaks(text)               # step 5  ← NEW (replaces _strip_excessive_blank_lines)
    return text.strip()


# ─────────────────────────────────────────────────────────────────────────────
# Core Extraction Engine
# ─────────────────────────────────────────────────────────────────────────────

def _extract_text_from_pdf(pdf_path: Path) -> tuple[str, bool]:
    """
    Open the PDF with pdfplumber and extract text using the visual-layout mode.

    Returns
    -------
    tuple[str, bool]
        (extracted_text, is_scanned_image)
        is_scanned_image is True when no machine-readable text layer was found.

    Raises
    ------
    pdfplumber.pdfminer.pdfparser.PDFSyntaxError
        If the file is corrupted or not a valid PDF.
    """
    pages_text: list[str] = []

    with pdfplumber.open(str(pdf_path)) as pdf:
        total_pages = len(pdf.pages)
        logger.info("Opened '%s' — %d page(s) detected.", pdf_path.name, total_pages)

        for page_num, page in enumerate(pdf.pages, start=1):
            try:
                page_text: Optional[str] = page.extract_text(**LAYOUT_KWARGS)

                if page_text is None:
                    page_text = ""

                pages_text.append(page_text)
                logger.debug(
                    "Page %d/%d extracted — %d character(s).",
                    page_num, total_pages, len(page_text),
                )

            except Exception as page_err:  # noqa: BLE001
                # A single bad page should not abort the entire document.
                logger.warning(
                    "Could not extract page %d/%d from '%s': %s — skipping page.",
                    page_num, total_pages, pdf_path.name, page_err,
                )
                pages_text.append("")  # preserve page-count alignment

    full_text = "\n\n".join(pages_text)
    is_scanned = not full_text.strip()  # empty → no machine-readable text layer
    return full_text, is_scanned


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def extract_pdf_to_text(
    input_pdf_path: str | Path,
    output_txt_path: str | Path,
) -> bool:
    """
    Extract text from a PDF using the visual-layout engine, apply the
    deterministic cleaning layer, and save the result as a UTF-8 .txt file.

    Parameters
    ----------
    input_pdf_path : str | Path
        Absolute or relative path to the source PDF file.
    output_txt_path : str | Path
        Absolute or relative path for the output .txt file.
        Parent directories are created automatically.

    Returns
    -------
    bool
        True  — extraction succeeded (even if flagged as scanned image).
        False — a fatal error prevented any output from being written.

    Side-effects
    ------------
    Writes the output .txt file and emits structured log messages.
    """
    input_pdf_path  = Path(input_pdf_path)
    output_txt_path = Path(output_txt_path)

    # ── Pre-flight: input validation ─────────────────────────────────────────
    if not input_pdf_path.exists():
        logger.error("Input file not found: '%s'", input_pdf_path)
        return False

    if not input_pdf_path.is_file():
        logger.error("Input path is not a file: '%s'", input_pdf_path)
        return False

    if input_pdf_path.suffix.lower() != ".pdf":
        logger.warning(
            "Input file '%s' does not have a .pdf extension — proceeding anyway.",
            input_pdf_path.name,
        )

    # ── Ensure output directory exists ───────────────────────────────────────
    try:
        output_txt_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as dir_err:
        logger.error("Cannot create output directory '%s': %s", output_txt_path.parent, dir_err)
        return False

    # ── Text Extraction ───────────────────────────────────────────────────────
    try:
        logger.info("Starting visual-layout extraction for: '%s'", input_pdf_path.name)
        raw_text, is_scanned = _extract_text_from_pdf(input_pdf_path)

    except FileNotFoundError:
        # Handles race condition where file disappears between exists() and open()
        logger.error("File disappeared before it could be read: '%s'", input_pdf_path)
        return False

    except Exception as pdf_err:
        # Catches pdfplumber PDFSyntaxError, PDFPasswordIncorrect, and other
        # corruption-related exceptions without importing them explicitly.
        logger.error(
            "Failed to open or parse PDF '%s': %s (%s)",
            input_pdf_path.name, pdf_err, type(pdf_err).__name__,
        )
        return False

    # ── Scanned Image Fallback ────────────────────────────────────────────────
    if is_scanned:
        logger.warning(
            "No machine-readable text layer found in '%s'. "
            "Document is likely a scanned image / photocopy. "
            "Flagging output as %s.",
            input_pdf_path.name, VISUAL_EXTRACTION_BLOCKED,
        )
        output_text = (
            f"{VISUAL_EXTRACTION_BLOCKED}\n\n"
            f"Source file : {input_pdf_path.resolve()}\n"
            f"Reason      : pdfplumber extracted an empty text layer. "
            f"The PDF appears to contain only rasterised images (scan/photocopy) "
            f"with no embedded Unicode text. "
            f"Re-process this file through an OCR engine (e.g. Tesseract / "
            f"Azure Document Intelligence) before AI auditor ingestion.\n"
        )
    else:
        # ── Deterministic Cleaning Pass ───────────────────────────────────────
        logger.info("Applying deterministic cleaning layer...")
        cleaned_text = clean_extracted_text(raw_text)
        output_text  = cleaned_text
        logger.info(
            "Cleaning complete — %d raw chars → %d cleaned chars.",
            len(raw_text), len(cleaned_text),
        )

    # ── Write Output ──────────────────────────────────────────────────────────
    try:
        output_txt_path.write_text(output_text, encoding="utf-8")
        logger.info("Output written to: '%s'", output_txt_path.resolve())
        return True

    except UnicodeEncodeError as enc_err:
        logger.error(
            "Unicode encoding error while writing '%s': %s — "
            "attempting lossy ASCII fallback.",
            output_txt_path, enc_err,
        )
        # Graceful degradation: write with error replacement so we don't lose the file
        try:
            output_txt_path.write_text(
                output_text.encode("utf-8", errors="replace").decode("utf-8"),
                encoding="utf-8",
            )
            logger.warning("Output written with replacement characters due to encoding issues.")
            return True
        except OSError as fallback_err:
            logger.error("Fallback write also failed: %s", fallback_err)
            return False

    except OSError as write_err:
        logger.error("Failed to write output file '%s': %s", output_txt_path, write_err)
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Batch Processing Helper
# ─────────────────────────────────────────────────────────────────────────────

def batch_extract(
    input_dir: str | Path,
    output_dir: str | Path,
    *,
    recursive: bool = False,
) -> dict[str, bool]:
    """
    Process all PDF files in a directory.

    Parameters
    ----------
    input_dir  : directory containing PDF files.
    output_dir : directory where .txt files will be saved (mirroring structure).
    recursive  : if True, also descend into subdirectories.

    Returns
    -------
    dict[str, bool]
        Mapping of {pdf_filename: success_flag} for every file processed.
    """
    input_dir  = Path(input_dir)
    output_dir = Path(output_dir)
    pattern    = "**/*.pdf" if recursive else "*.pdf"
    results: dict[str, bool] = {}

    pdf_files = sorted(input_dir.glob(pattern))

    if not pdf_files:
        logger.warning("No PDF files found in '%s'.", input_dir)
        return results

    logger.info("Batch processing %d PDF file(s) from '%s'.", len(pdf_files), input_dir)

    for pdf_file in pdf_files:
        relative   = pdf_file.relative_to(input_dir)
        output_txt = (output_dir / relative).with_suffix(".txt")
        results[str(relative)] = extract_pdf_to_text(pdf_file, output_txt)

    successful = sum(results.values())
    logger.info(
        "Batch complete — %d/%d file(s) processed successfully.",
        successful, len(results),
    )
    return results


# ─────────────────────────────────────────────────────────────────────────────
# CLI Entry-point
# ─────────────────────────────────────────────────────────────────────────────

def _cli() -> None:
    """Minimal command-line interface for single-file or batch invocation."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="pdf_text_extractor",
        description=(
            "Visual Layout Text Extraction & Flattening — "
            "Automated Vendor Document Auditing Pipeline (Method 1)"
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # --- single file ---
    single = subparsers.add_parser("extract", help="Extract a single PDF file.")
    single.add_argument("input",  type=str, help="Path to the source PDF.")
    single.add_argument("output", type=str, help="Path for the output .txt file.")

    # --- batch ---
    batch = subparsers.add_parser("batch", help="Batch-extract all PDFs in a directory.")
    batch.add_argument("input_dir",  type=str, help="Source directory containing PDFs.")
    batch.add_argument("output_dir", type=str, help="Destination directory for .txt files.")
    batch.add_argument(
        "--recursive", "-r",
        action="store_true",
        help="Descend into subdirectories.",
    )

    args = parser.parse_args()

    if args.command == "extract":
        success = extract_pdf_to_text(args.input, args.output)
        sys.exit(0 if success else 1)

    elif args.command == "batch":
        results = batch_extract(args.input_dir, args.output_dir, recursive=args.recursive)
        any_failure = not all(results.values())
        sys.exit(1 if any_failure else 0)


if __name__ == "__main__":
    _cli()
