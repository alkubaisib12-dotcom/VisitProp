import { PropertyReport } from './types';
import { sanitizeFilename, generatePdfFilename } from './pdfUtils';
import { downloadBundleZip } from './api';

const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB total (files + pdfHtml)
const IMAGE_COMPRESS_THRESHOLD = 2 * 1024 * 1024; // compress images larger than 2MB
const IMAGE_MAX_DIM = 2000; // max width/height after resize
const JPEG_QUALITY = 0.82;

async function fetchBlob(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function getFileExtensionFromNameOrMime(name: string, mime?: string): string {
  const lastDot = name.lastIndexOf('.');
  if (lastDot > 0) return name.substring(lastDot);
  if (mime && mime.startsWith('image/')) return `.${mime.split('/')[1]}`;
  return '';
}

function blobToFile(blob: Blob, fileName: string): File {
  const type = blob.type || 'application/octet-stream';
  return new File([blob], fileName, { type });
}

function pickBestName(obj: unknown, fallback: string): string {
  if (!obj || typeof obj !== 'object') return fallback;
  const o = obj as Record<string, any>;
  if (o.file instanceof File && o.file.name) return o.file.name;
  if (typeof o.name === 'string' && o.name.trim()) return o.name.trim();
  if (typeof o.originalName === 'string' && o.originalName.trim()) return o.originalName.trim();
  if (typeof o.filename === 'string' && o.filename.trim()) return o.filename.trim();
  return fallback;
}

function estimateStringBytes(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    return s.length * 2;
  }
}

async function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.loading = 'eager';
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function compressImageFileIfNeeded(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  if (file.size < IMAGE_COMPRESS_THRESHOLD) return file;

  try {
    const img = await loadImageFromBlob(file);

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return file;

    const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(w, h));
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    ctx.drawImage(img, 0, 0, outW, outH);

    const outBlob: Blob | null = await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY);
    });

    if (!outBlob) return file;
    if (outBlob.size >= file.size) return file;

    const base = sanitizeFilename(file.name.replace(/\.[^.]+$/, '') || 'photo');
    const newName = `${base}.jpg`;
    return new File([outBlob], newName, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  }
}

/**
 * IMPORTANT:
 * - We DO NOT inline images into HTML (base64) because it explodes size.
 * - For printing/exporting HTML, images must be normal https URLs (uploadedUrl).
 */
function assertNoBlobImages(root: HTMLElement): void {
  const imgs = Array.from(root.querySelectorAll('img'));
  const bad = imgs.find((img) => {
    const src = (img.getAttribute('src') || '').trim();
    return src.startsWith('blob:');
  });
  if (bad) {
    throw new Error(
      'Cannot generate PDF HTML with local (blob) images. Upload photos first so <img src> uses uploadedUrl (https).'
    );
  }
}

function collectCssText(): string {
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + '\n';
    } catch {
      // cross-origin stylesheet => ignore
    }
  }
  return css;
}

/**
 * Build HTML from the SAME DOM used for printing (#pdf-content),
 * with injected CSS (no image inlining).
 * Backend should print this HTML to a real PDF.
 */
export async function buildPdfHtmlFromDom(pdfContentId: string = 'pdf-content'): Promise<string> {
  const el = document.getElementById(pdfContentId);
  if (!el) throw new Error(`PDF content not found (missing #${pdfContentId}).`);

  const clone = el.cloneNode(true) as HTMLElement;
  clone.classList.remove('pdf-content-hidden');
  clone.style.display = 'block';

  // critical: don't allow blob images (forces uploadedUrl usage)
  assertNoBlobImages(clone);

  const cssText = collectCssText();
  const baseHref = window.location.origin + '/';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <base href="${baseHref}">
  <style>${cssText}</style>
  <style>
    @page { size: A4; margin: 10mm; }
    html, body { background: #fff; margin: 0; padding: 0; }
  </style>
</head>
<body>
  ${clone.outerHTML}
</body>
</html>`;
}

export async function downloadReportZip(report: PropertyReport): Promise<void> {
  const filesPayload: Array<{ field: string; file: File }> = [];

  // Main photos
  (report.mainPhotos || []).forEach((p: any, i: number) => {
    if (p?.file instanceof File) {
      filesPayload.push({ field: 'mainPhotos', file: p.file });
    } else if (p?.uploadedUrl) {
      filesPayload.push({ field: 'mainPhotos', file: new File([], `Main Photo ${i + 1}`) });
    }
  });

  // Complaint files
  (report.complaintFiles || []).forEach((f: any, i: number) => {
    if (f?.file instanceof File) {
      filesPayload.push({ field: 'complaintFiles', file: f.file });
    } else if (f?.uploadedUrl) {
      const base = pickBestName(f, `Complaint File ${i + 1}`);
      filesPayload.push({ field: 'complaintFiles', file: new File([], sanitizeFilename(base)) });
    }
  });

  // Finding photos (0-based, double underscore)
  (report.findings || []).forEach((finding: any, idx: number) => {
    const field = `findingPhotos__${idx}`;
    (finding?.photos || []).forEach((p: any, j: number) => {
      if (p?.file instanceof File) {
        filesPayload.push({ field, file: p.file });
      } else if (p?.uploadedUrl) {
        filesPayload.push({ field, file: new File([], `Photo ${j + 1}`) });
      }
    });
  });

  // Replace placeholders by fetching blobs (best-effort)
  for (let i = 0; i < filesPayload.length; i++) {
    const item = filesPayload[i];
    const hasRealFile = item.file instanceof File && item.file.size > 0;
    if (hasRealFile) continue;

    if (item.field === 'mainPhotos') {
      const idx = filesPayload.slice(0, i + 1).filter((x) => x.field === 'mainPhotos').length - 1;
      const url = report.mainPhotos?.[idx]?.uploadedUrl;

      const base = pickBestName(report.mainPhotos?.[idx], `Main Photo ${idx + 1}`);
      const blob = url ? await fetchBlob(url) : null;
      if (blob) {
        const ext = getFileExtensionFromNameOrMime(base, blob.type);
        const fileName = sanitizeFilename(`${base}${ext && !base.endsWith(ext) ? ext : ''}`);
        filesPayload[i] = { field: item.field, file: blobToFile(blob, fileName) };
      }
      continue;
    }

    if (item.field === 'complaintFiles') {
      const idx = filesPayload.slice(0, i + 1).filter((x) => x.field === 'complaintFiles').length - 1;
      const url = report.complaintFiles?.[idx]?.uploadedUrl;

      const base = pickBestName(report.complaintFiles?.[idx], `Complaint File ${idx + 1}`);
      const blob = url ? await fetchBlob(url) : null;
      if (blob) {
        const ext = getFileExtensionFromNameOrMime(base, blob.type);
        const fileName = sanitizeFilename(`${base}${ext && !base.endsWith(ext) ? ext : ''}`);
        filesPayload[i] = { field: item.field, file: blobToFile(blob, fileName) };
      }
      continue;
    }

    if (item.field.startsWith('findingPhotos__')) {
      const findingIdx = Number(item.field.split('__')[1]);
      const photoIdx = filesPayload.filter((x) => x.field === item.field).indexOf(item);

      const url = report.findings?.[findingIdx]?.photos?.[photoIdx]?.uploadedUrl;

      const base = pickBestName(report.findings?.[findingIdx]?.photos?.[photoIdx], `Photo ${photoIdx + 1}`);
      const blob = url ? await fetchBlob(url) : null;
      if (blob) {
        const ext = getFileExtensionFromNameOrMime(base, blob.type);
        const fileName = sanitizeFilename(`${base}${ext && !base.endsWith(ext) ? ext : ''}`);
        filesPayload[i] = { field: item.field, file: blobToFile(blob, fileName) };
      }
      continue;
    }
  }

  // OPTIONAL: compress large images to keep total size reasonable
  for (let i = 0; i < filesPayload.length; i++) {
    const f = filesPayload[i].file;
    if (f instanceof File && f.size > 0 && f.type.startsWith('image/')) {
      filesPayload[i].file = await compressImageFileIfNeeded(f);
    }
  }

  const pdfHtml = await buildPdfHtmlFromDom('pdf-content');
  const pdfFileName = generatePdfFilename(report);

  // total size check (files + pdfHtml bytes)
  const filesBytes = filesPayload.reduce((sum, x) => sum + (x.file?.size || 0), 0);
  const htmlBytes = estimateStringBytes(pdfHtml);
  const total = filesBytes + htmlBytes;

  if (total > MAX_TOTAL_BYTES) {
    throw new Error(
      `Bundle too large: ${formatBytes(total)}. Max allowed is ${formatBytes(MAX_TOTAL_BYTES)}. ` +
        `Try removing some photos or let compression reduce size.`
    );
  }

  await downloadBundleZip(report, filesPayload, { pdfHtml, pdfFileName });
}

export function validateReportForZip(report: PropertyReport | null): string | null {
  if (!report) return 'يرجى اختيار عقار أولاً | Please select a property first';

  const hasAnyFiles =
    (report.mainPhotos?.length || 0) > 0 ||
    (report.findings || []).some((f: any) => (f.photos?.length || 0) > 0) ||
    (report.complaintFiles?.length || 0) > 0;

  const hasAnyText =
    !!report.visitType?.trim() ||
    !!report.locationDescription?.trim() ||
    !!report.locationLink?.trim() ||
    !!report.additionalNotes?.trim() ||
    !!report.complaint?.trim() ||
    (report.findings || []).some((f: any) => (f.text || '').trim()) ||
    (report.actions || []).some((a: any) => (a.text || '').trim());

  if (!hasAnyFiles && !hasAnyText) return 'لا توجد بيانات أو ملفات للتحميل | No data or files to download';
  return null;
}
