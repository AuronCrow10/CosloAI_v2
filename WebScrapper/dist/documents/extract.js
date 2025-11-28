// src/documents/extract.ts
import path from 'node:path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
export async function extractTextFromBuffer(buffer, filename) {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.pdf') {
        const result = await pdfParse(buffer);
        // pdf-parse puts text as `text`
        return result.text || '';
    }
    if (ext === '.docx') {
        const { value } = await mammoth.extractRawText({ buffer });
        return value || '';
    }
    // You can add .doc, .txt, etc. here if needed
    throw new Error(`Unsupported file extension: ${ext}`);
}
