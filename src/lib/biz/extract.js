// Text extraction for knowledge-base uploads (spec business-bots "Knowledge base
// ingestion", design D8).
//
// PDF through unpdf, DOCX through mammoth, TXT and MD as UTF-8. The original file
// is never stored: the caller keeps only what this returns.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MIN_TEXT_CHARS = 20;

export const FILE_TOO_LARGE = "Tệp vượt quá 10 MB";
export const UNSUPPORTED_TYPE = "Chỉ hỗ trợ PDF, DOCX, TXT, MD";
export const UNREADABLE_SCAN = "Không đọc được chữ trong tệp (có thể là ảnh scan)";

const PDF_MIMES = new Set(["application/pdf"]);
const DOCX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
]);
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/md", "application/octet-stream"]);

/**
 * Magic bytes of a format the product does NOT accept (ZIP container — which an
 * .xlsx/.odt also is — and the OLE2 header of an old .doc/.xls). A browser that
 * cannot name a MIME type sends `application/octet-stream` for everything, so the
 * extension alone is not enough: such a file must be refused, not chunked as text.
 */
function looksBinary(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return true; // PK zip: xlsx, odt, a docx we did not route to mammoth
  }
  if (buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    return true; // OLE2: legacy .doc/.xls
  }
  // A NUL byte in the first 4 KiB is never text.
  const window = buffer.subarray(0, 4096);
  return window.includes(0);
}

/** `pdf` | `docx` | `text`, or null when the file is not one the product accepts. */
export function detectFileKind(filename = "", mime = "") {
  const name = String(filename || "").toLowerCase();
  const type = String(mime || "").toLowerCase().split(";")[0].trim();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";

  if (ext === "pdf" || PDF_MIMES.has(type)) return "pdf";
  if (ext === "docx" || DOCX_MIMES.has(type)) return "docx";
  if (ext === "txt" || ext === "md" || TEXT_MIMES.has(type)) return "text";
  return null;
}

/** The Vietnamese 415 message for a file that is not PDF, DOCX, TXT or MD. */
export function contentTypeError() {
  return UNSUPPORTED_TYPE;
}

async function pdfText(bytes) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n\n") : String(text ?? "");
}

async function docxText(bytes) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return String(result?.value ?? "");
}

/** How many non-whitespace characters `text` contains. */
export function nonWhitespaceLength(text) {
  return String(text ?? "").replace(/\s+/gu, "").length;
}

/**
 * Extract the text of an uploaded file.
 *
 * @param {{ bytes: Uint8Array|Buffer, filename?: string, mime?: string }} file
 * @returns {Promise<{ ok:true, text:string, kind:string } |
 *                   { ok:false, status:number, error:string }>}
 */
export async function extractFileText({ bytes, filename = "", mime = "" } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  if (buffer.length > MAX_UPLOAD_BYTES) return { ok: false, status: 413, error: FILE_TOO_LARGE };

  const kind = detectFileKind(filename, mime);
  if (!kind) return { ok: false, status: 415, error: UNSUPPORTED_TYPE };
  // A text/DOCX claim on a zip- or OLE-shaped file is an `.xlsx` renamed or sent
  // with a generic MIME type: refuse it rather than chunk binary noise.
  if (kind !== "pdf" && looksBinary(buffer)) {
    return { ok: false, status: 415, error: UNSUPPORTED_TYPE };
  }

  try {
    let text;
    if (kind === "pdf") text = await pdfText(buffer);
    else if (kind === "docx") text = await docxText(buffer);
    else text = buffer.toString("utf8");
    return { ok: true, kind, text: String(text ?? "").trim() };
  } catch {
    // A corrupt PDF is indistinguishable from a scanned one to the customer, and
    // the actionable advice is the same: upload a text-based file.
    return { ok: false, status: 422, error: UNREADABLE_SCAN };
  }
}
