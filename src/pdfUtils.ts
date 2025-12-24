import { PropertyReport } from './types';

export function formatBahrainDate(date: Date = new Date()): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Bahrain',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };

  const formatter = new Intl.DateTimeFormat('en-GB', options);
  const parts = formatter.formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value || '0000';
  const month = parts.find((p) => p.type === 'month')?.value || '00';
  const day = parts.find((p) => p.type === 'day')?.value || '00';
  const hour = parts.find((p) => p.type === 'hour')?.value || '00';
  const minute = parts.find((p) => p.type === 'minute')?.value || '00';

  return `${year}-${month}-${day} ${hour}:${minute} (Asia/Bahrain)`;
}

export function getBahrainDateString(date: Date = new Date()): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Bahrain',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };

  const formatter = new Intl.DateTimeFormat('en-GB', options);
  const parts = formatter.formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value || '0000';
  const month = parts.find((p) => p.type === 'month')?.value || '00';
  const day = parts.find((p) => p.type === 'day')?.value || '00';

  return `${year}-${month}-${day}`;
}

export function sanitizeFilename(filename: string): string {
  return (filename || '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function generatePdfFilename(report: PropertyReport): string {
  const dateString = report?.submittedAt
    ? getBahrainDateString(new Date(report.submittedAt))
    : getBahrainDateString();

  const code = (report?.propertyCode || '').trim() || 'Report';
  const name = (report?.propertyName || '').trim() || 'Property';

  return sanitizeFilename(`${code} - ${name} - ${dateString}.pdf`);
}

function raf2(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function waitForFonts(timeoutMs: number = 2500): Promise<void> {
  const anyDoc = document as any;
  const fonts = anyDoc?.fonts;
  if (!fonts?.ready) return Promise.resolve();

  return Promise.race([
    fonts.ready.then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function waitForImages(root: HTMLElement, timeoutMs: number = 4000): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  if (imgs.length === 0) return Promise.resolve();

  const waits = imgs.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      setTimeout(() => resolve(), timeoutMs);
    });
  });

  return Promise.all(waits).then(() => undefined);
}

/**
 * Prints the already-rendered #pdf-content DOM.
 * Waiting here is important because calling window.print too early often results in a blank page.
 */
export async function printReport(report: PropertyReport): Promise<void> {
  const filename = generatePdfFilename(report);
  const originalTitle = document.title;

  document.title = filename;

  try {
    // Ensure React committed DOM updates
    await raf2();

    // Ensure pdf-content exists and has renderable content
    const pdfEl = document.getElementById('pdf-content');
    if (!pdfEl) {
      // still try printing, but this explains why white page happens
      console.warn('printReport: missing #pdf-content in DOM');
      await raf2();
      window.print();
      return;
    }

    // Wait fonts + images inside pdf-content to avoid blank/white print
    await waitForFonts();
    await waitForImages(pdfEl);
    await raf2();

    // Trigger print
    window.print();
  } finally {
    setTimeout(() => {
      document.title = originalTitle;
    }, 1000);
  }
}

/**
 * Everything optional: only block if no report (no property selected).
 */
export function validateReportForPdf(report: PropertyReport | null): string | null {
  if (!report) return 'يرجى اختيار عقار أولاً | Please select a property first';
  return null;
}
