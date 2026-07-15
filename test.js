import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, Image } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';
import { createRequire } from 'module';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

// Mock HTMLElement in Node environment to prevent PDFJS paintInlineImageXObject crashes
globalThis.HTMLElement = class HTMLElement { };

const blobMap = new Map();
let blobCounter = 0;

if (globalThis.URL) {
    globalThis.URL.createObjectURL = (blob) => {
        const id = `blob:nodedata/${blobCounter++}`;
        blobMap.set(id, blob);
        return id;
    };
    globalThis.URL.revokeObjectURL = (url) => {
        blobMap.delete(url);
    };
} else {
    globalThis.URL = {
        createObjectURL: (blob) => {
            const id = `blob:nodedata/${blobCounter++}`;
            blobMap.set(id, blob);
            return id;
        },
        revokeObjectURL: (url) => {
            blobMap.delete(url);
        }
    };
}

const OriginalImage = Image;

class WrappedImage extends OriginalImage {
    constructor() {
        super();
    }
    set src(value) {
        if (typeof value === 'string' && value.startsWith('blob:nodedata/')) {
            const blob = blobMap.get(value);
            if (blob) {
                if (typeof blob.arrayBuffer === 'function') {
                    blob.arrayBuffer().then(arrayBuffer => {
                        super.src = Buffer.from(arrayBuffer);
                    }).catch(err => {
                        if (this.onerror) this.onerror(err);
                    });
                } else if (blob._buffer) {
                    super.src = blob._buffer;
                } else {
                    super.src = value;
                }
                return;
            }
        }
        super.src = value;
    }
    get src() {
        return super.src;
    }
}
globalThis.Image = WrappedImage;

// Mock FontFace CSS loading API for PDFJS font loading in Node.js
globalThis.FontFace = class FontFace {
    constructor() {
        this.loaded = Promise.resolve(this);
    }
    load() {
        return Promise.resolve(this);
    }
};

class MockStyleSheet {
    constructor() {
        this.cssRules = [];
    }
    insertRule(rule, index) {
        this.cssRules.push(rule);
        return 0;
    }
}

class MockElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.style = {};
        this.sheet = new MockStyleSheet();
    }
    appendChild(child) {
        return child;
    }
    getElementsByTagName(name) {
        return [new MockElement(name)];
    }
    remove() { }
}

// Mock document object to support inline images and font stylesheet elements in PDFJS canvas rendering
globalThis.document = {
    documentElement: new MockElement('html'),
    head: new MockElement('head'),
    body: new MockElement('body'),
    fonts: {
        add() { },
        delete() { }
    },
    createElement(tagName) {
        if (tagName === 'canvas') {
            return createCanvas(1, 1);
        }
        return new MockElement(tagName);
    },
    getElementById(id) {
        return null;
    },
    getElementsByTagName(tagName) {
        return [new MockElement(tagName)];
    }
};

const require = createRequire(import.meta.url);
const PDFJS = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pdfPath = 'C:\\Users\\adamamzar\\Downloads\\GPO - Automatic Certificate Checker\\JURUKUR TERAS SDN. BHD\\test.pdf';
const outputTxtPath = path.join(__dirname, 'output.txt');
const outputDocxPath = path.join(__dirname, 'output.docx');

// Custom function to render a PDF page object directly to a PNG buffer
async function renderPageToImageBuffer(page) {
    // Scale 2.0 provides high-resolution images for higher OCR accuracy
    const viewport = page.getViewport(2.0);

    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    const renderContext = {
        canvasContext: context,
        viewport: viewport
    };

    const renderTask = page.render(renderContext);
    await renderTask.promise;

    return canvas.toBuffer('image/png');
}

// Convert extracted results to a structured DOCX file
async function saveAsDocx(pagesResults, outputPath) {
    const docChildren = [];

    docChildren.push(new Paragraph({
        text: "Extracted PDF OCR Report",
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 200 }
    }));

    for (const res of pagesResults) {
        docChildren.push(new Paragraph({
            text: `Page ${res.pageNum}`,
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 }
        }));

        const lines = res.text.split('\n');
        for (const line of lines) {
            docChildren.push(new Paragraph({
                children: [
                    new TextRun({
                        text: line,
                        font: "Arial",
                        size: 22
                    })
                ],
                spacing: { after: 40 }
            }));
        }
    }

    const doc = new Document({
        sections: [{
            properties: {},
            children: docChildren
        }]
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);
}

(async () => {
    console.log('Reading PDF file...');
    try {
        if (!fs.existsSync(pdfPath)) {
            console.error(`File not found at path: ${pdfPath}`);
            return;
        }

        const dataBuffer = fs.readFileSync(pdfPath);

        // Initialize PDFJS Document once
        const doc = await PDFJS.getDocument(dataBuffer);
        const totalPages = doc.numPages;
        console.log(`PDF Loaded successfully. Total pages: ${totalPages}`);

        const pagesResults = [];
        let tesseractWorker = null;

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            console.log(`\nProcessing Page ${pageNum} of ${totalPages}...`);
            const page = await doc.getPage(pageNum);

            try {
                const imageBuffer = await renderPageToImageBuffer(page);

                if (imageBuffer) {
                    if (!tesseractWorker) {
                        tesseractWorker = await createWorker('eng', 1, {
                            langPath: path.join(__dirname, 'tessdata'),
                            logger: m => {
                                if (m.status === 'recognizing text') {
                                    console.log(`  OCR Progress: ${(m.progress * 100).toFixed(0)}%`);
                                }
                            }
                        });
                    }

                    const result = await tesseractWorker.recognize(imageBuffer);
                    const ocrText = result.data.text.trim();
                    pagesResults.push({
                        pageNum,
                        text: ocrText
                    });
                } else {
                    console.error(`  Failed to render Page ${pageNum} to image.`);
                    pagesResults.push({
                        pageNum,
                        text: '[Failed to render page image]'
                    });
                }
            } catch (ocrErr) {
                console.error(`  Error performing OCR on Page ${pageNum}:`, ocrErr);
                pagesResults.push({
                    pageNum,
                    text: `[OCR Error: ${ocrErr.message}]`
                });
            }
        }

        if (tesseractWorker) {
            await tesseractWorker.terminate();
        }

        doc.destroy();

        // 1. Build text output
        let txtOutput = '';
        for (const res of pagesResults) {
            txtOutput += `\n=========================================\n`;
            txtOutput += `PAGE ${res.pageNum}\n`;
            txtOutput += `=========================================\n`;
            txtOutput += `${res.text}\n`;
        }

        // Write to output.txt
        fs.writeFileSync(outputTxtPath, txtOutput, 'utf8');
        console.log(`\nText file saved to: ${outputTxtPath}`);

        // 2. Build docx output
        console.log('Generating Word Document (.docx)...');
        await saveAsDocx(pagesResults, outputDocxPath);
        console.log(`Word Document saved to: ${outputDocxPath}`);

        console.log('\nSuccess! All pages processed successfully.');

    } catch (error) {
        console.error('Error processing PDF:', error);
    }
})();


