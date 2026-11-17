'use strict';

const crypto = require('crypto');
const { parentPort, workerData } = require('worker_threads');
const PptxGenJS = require('../office-lite/node_modules/pptxgenjs');
const { imageSize } = require('../office-lite/node_modules/image-size');
const {
  fail,
  compileAndInspectTags,
  renderTemplateBuffer,
  writeTempVerified,
  readPptxSummary,
} = require('./office-template-core');

const FONT_FACE = 'Microsoft YaHei';
const COLORS = Object.freeze({
  navy: '1B365D',
  accent: '2563EB',
  bgLight: 'F8FAFC',
  panel: 'FFFFFF',
  border: 'CBD5E1',
  textPrimary: '0F172A',
  textMuted: '475569',
  footerText: '64748B',
  altRow: 'F1F5F9',
});

function sourceLine(sources) {
  return `来源：${sources.join('、')}`;
}

function addSourceFooterAndNotes(slide, sources, notes) {
  const footer = sourceLine(sources);
  slide.addShape('line', { x: 0.5, y: 5.10, w: 9.0, h: 0, line: { color: COLORS.border, pt: 0.75 } });
  slide.addText(footer, {
    x: 0.5,
    y: 5.15,
    w: 9.0,
    h: 0.34,
    fontFace: FONT_FACE,
    fontSize: 9,
    color: COLORS.footerText,
    valign: 'middle',
  });
  const noteParts = [footer];
  if (notes) noteParts.push(notes);
  slide.addNotes(noteParts.join('\n'));
}

function addHeaderBand(slide, title, badgeText) {
  slide.background = { color: COLORS.bgLight };
  slide.addShape('rect', { x: 0, y: 0, w: 10.0, h: 0.10, fill: { color: COLORS.navy }, line: { color: COLORS.navy, pt: 0 } });
  slide.addText(title, {
    x: 0.5,
    y: 0.25,
    w: 7.4,
    h: 0.55,
    fontFace: FONT_FACE,
    fontSize: 20,
    bold: true,
    color: COLORS.textPrimary,
    valign: 'middle',
  });
  slide.addText(badgeText, {
    x: 8.1,
    y: 0.30,
    w: 1.4,
    h: 0.42,
    fontFace: FONT_FACE,
    fontSize: 10,
    bold: true,
    align: 'right',
    color: COLORS.accent,
    valign: 'middle',
  });
}

async function createFromLayouts(input) {
  const maxOutputBytes = Number.isSafeInteger(input.maxOutputBytes) && input.maxOutputBytes > 0
    ? input.maxOutputBytes
    : 16 * 1024 * 1024;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = String(input.title || '工作汇报');
  if (input.author) pptx.author = String(input.author);

  const imageMap = input.images || {};
  for (const spec of input.slides || []) {
    const slide = pptx.addSlide();
    if (spec.layout === 'cover') {
      slide.background = { color: COLORS.navy };
      slide.addShape('rect', { x: 0, y: 0, w: 0.28, h: 5.625, fill: { color: COLORS.accent }, line: { color: COLORS.accent, pt: 0 } });
      slide.addText(spec.title, {
        x: 0.85,
        y: 1.35,
        w: spec.imagePath ? 6.2 : 8.4,
        h: 1.3,
        fontFace: FONT_FACE,
        fontSize: 30,
        bold: true,
        color: 'FFFFFF',
        valign: 'middle',
      });
      if (spec.subtitle) {
        slide.addText(spec.subtitle, {
          x: 0.85,
          y: 2.75,
          w: spec.imagePath ? 6.2 : 8.4,
          h: 0.8,
          fontFace: FONT_FACE,
          fontSize: 16,
          color: 'E2E8F0',
          valign: 'top',
        });
      }
      if (spec.meta) {
        slide.addText(spec.meta, {
          x: 0.85,
          y: 3.75,
          w: 8.4,
          h: 0.45,
          fontFace: FONT_FACE,
          fontSize: 12,
          color: 'CBD5E1',
        });
      }
      if (spec.imagePath) {
        const imgRaw = imageMap[spec.imagePath];
        if (!imgRaw) throw fail('A9_OFFICE_IMAGE_MISSING');
        const imgBuf = Buffer.from(imgRaw);
        const dim = imageSize(imgBuf);
        if (!dim || !dim.width || !dim.height || !['png', 'jpg', 'jpeg'].includes(String(dim.type || '').toLowerCase())) {
          throw fail('A9_OFFICE_IMAGE_UNSUPPORTED');
        }
        const mime = dim.type === 'jpg' ? 'jpeg' : dim.type;
        const maxW = 2.0;
        const maxH = 2.0;
        const scale = Math.min(maxW / dim.width, maxH / dim.height);
        const w = Math.max(0.4, dim.width * scale);
        const h = Math.max(0.4, dim.height * scale);
        slide.addImage({
          data: `image/${mime};base64,${imgBuf.toString('base64')}`,
          x: 7.35,
          y: 1.35,
          w,
          h,
        });
      }
      slide.addShape('line', { x: 0.85, y: 5.05, w: 8.6, h: 0, line: { color: '64748B', pt: 0.75 } });
      const coverFooter = sourceLine(spec.sources);
      slide.addText(coverFooter, {
        x: 0.85,
        y: 5.12,
        w: 8.6,
        h: 0.34,
        fontFace: FONT_FACE,
        fontSize: 9,
        color: 'CBD5E1',
      });
      slide.addNotes([coverFooter, ...(spec.notes ? [spec.notes] : [])].join('\n'));
      continue;
    }

    if (spec.layout === 'toc') {
      addHeaderBand(slide, spec.title, '目录');
      const items = spec.items || [];
      const twoCols = items.length > 8;
      const perCol = twoCols ? Math.ceil(items.length / 2) : items.length;
      const renderColumn = (colItems, startNum, xPos, width) => {
        const rows = colItems.map((item, idx) => {
          const text = typeof item === 'string'
            ? `${startNum + idx}. ${item}`
            : `${startNum + idx}. ${item.title}${item.detail ? ` — ${item.detail}` : ''}`;
          return { text, options: { bullet: false, breakLine: true, paraSpaceAfter: 6 } };
        });
        slide.addText(rows, {
          x: xPos,
          y: 1.0,
          w: width,
          h: 3.9,
          fontFace: FONT_FACE,
          fontSize: 13,
          color: COLORS.textPrimary,
          valign: 'top',
          fill: { color: COLORS.panel },
          line: { color: COLORS.border, pt: 0.75 },
          margin: [10, 12, 10, 12],
        });
      };
      if (twoCols) {
        renderColumn(items.slice(0, perCol), 1, 0.5, 4.35);
        renderColumn(items.slice(perCol), perCol + 1, 5.15, 4.35);
      } else {
        renderColumn(items, 1, 0.5, 9.0);
      }
      addSourceFooterAndNotes(slide, spec.sources, spec.notes);
      continue;
    }

    if (spec.layout === 'two_column') {
      addHeaderBand(slide, spec.title, '双栏对比');
      const drawCol = (col, xPos) => {
        slide.addShape('rect', {
          x: xPos,
          y: 0.95,
          w: 4.35,
          h: 3.98,
          fill: { color: COLORS.panel },
          line: { color: COLORS.border, pt: 1 },
        });
        slide.addShape('rect', {
          x: xPos,
          y: 0.95,
          w: 4.35,
          h: 0.45,
          fill: { color: COLORS.navy },
          line: { color: COLORS.navy, pt: 0 },
        });
        slide.addText(col.heading, {
          x: xPos + 0.14,
          y: 0.98,
          w: 4.07,
          h: 0.38,
          fontFace: FONT_FACE,
          fontSize: 13,
          bold: true,
          color: 'FFFFFF',
          valign: 'middle',
        });
        const runs = (col.items || []).map(item => ({
          text: item,
          options: { bullet: true, breakLine: true, paraSpaceAfter: 5 },
        }));
        if (runs.length) {
          slide.addText(runs, {
            x: xPos + 0.14,
            y: 1.50,
            w: 4.07,
            h: 3.30,
            fontFace: FONT_FACE,
            fontSize: 12,
            color: COLORS.textPrimary,
            valign: 'top',
          });
        }
      };
      drawCol(spec.left, 0.5);
      drawCol(spec.right, 5.15);
      addSourceFooterAndNotes(slide, spec.sources, spec.notes);
      continue;
    }

    if (spec.layout === 'table') {
      addHeaderBand(slide, spec.title, '数据表');
      const tableRows = [
        spec.headers.map(h => ({
          text: h,
          options: { bold: true, fill: { color: COLORS.navy }, color: 'FFFFFF', align: 'left' },
        })),
        ...(spec.rows || []).map((row, rIdx) => row.map(cell => ({
          text: cell,
          options: { fill: { color: rIdx % 2 === 1 ? COLORS.altRow : COLORS.panel }, color: COLORS.textPrimary },
        }))),
      ];
      slide.addTable(tableRows, {
        x: 0.5,
        y: 0.98,
        w: 9.0,
        fontFace: FONT_FACE,
        fontSize: 11,
        border: { pt: 0.75, color: COLORS.border },
        valign: 'middle',
        margin: [4, 6, 4, 6],
      });
      addSourceFooterAndNotes(slide, spec.sources, spec.notes);
      continue;
    }

    if (spec.layout === 'summary') {
      addHeaderBand(slide, spec.title, '总结');
      const hasNext = Array.isArray(spec.nextSteps) && spec.nextSteps.length > 0;
      const takeawayH = hasNext ? 2.15 : 3.98;
      slide.addShape('rect', {
        x: 0.5,
        y: 0.95,
        w: 9.0,
        h: takeawayH,
        fill: { color: COLORS.panel },
        line: { color: COLORS.border, pt: 1 },
      });
      slide.addText('核心结论', {
        x: 0.68,
        y: 1.03,
        w: 8.6,
        h: 0.34,
        fontFace: FONT_FACE,
        fontSize: 13,
        bold: true,
        color: COLORS.navy,
      });
      slide.addText((spec.takeaways || []).map(t => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 5 } })), {
        x: 0.68,
        y: 1.40,
        w: 8.6,
        h: takeawayH - 0.52,
        fontFace: FONT_FACE,
        fontSize: 12,
        color: COLORS.textPrimary,
        valign: 'top',
      });
      if (hasNext) {
        slide.addShape('rect', {
          x: 0.5,
          y: 3.25,
          w: 9.0,
          h: 1.68,
          fill: { color: 'EFF6FF' },
          line: { color: '93C5FD', pt: 1 },
        });
        slide.addText('下一步行动', {
          x: 0.68,
          y: 3.32,
          w: 8.6,
          h: 0.32,
          fontFace: FONT_FACE,
          fontSize: 12,
          bold: true,
          color: COLORS.accent,
        });
        slide.addText(spec.nextSteps.map(s => ({ text: s, options: { bullet: true, breakLine: true, paraSpaceAfter: 4 } })), {
          x: 0.68,
          y: 3.66,
          w: 8.6,
          h: 1.20,
          fontFace: FONT_FACE,
          fontSize: 11,
          color: COLORS.textPrimary,
          valign: 'top',
        });
      }
      addSourceFooterAndNotes(slide, spec.sources, spec.notes);
      continue;
    }

    throw fail('A9_OFFICE_LAYOUT_UNSUPPORTED');
  }

  const outBuf = await pptx.write({ outputType: 'nodebuffer', compression: true });
  if (outBuf.length > maxOutputBytes) throw fail('A9_OFFICE_BYTE_LIMIT');
  const readback = readPptxSummary(outBuf, maxOutputBytes);
  if (readback.slideCount !== (input.slides || []).length) {
    throw fail('A9_OFFICE_READBACK_MISMATCH');
  }
  const written = writeTempVerified(input.tempPath, input.tempIdentity, outBuf);
  return {
    ...written,
    slideCount: readback.slideCount,
    slides: readback.slides,
    mode: 'layouts',
    workerExitCode: 0,
  };
}

async function fillTemplatePptx(input) {
  const maxOutputBytes = Number.isSafeInteger(input.maxOutputBytes) && input.maxOutputBytes > 0
    ? input.maxOutputBytes
    : 16 * 1024 * 1024;
  const templateBuffer = Buffer.from(input.templateBuffer);
  compileAndInspectTags(templateBuffer, 'pptx', { maxBytes: 4 * 1024 * 1024 });
  const outBuf = renderTemplateBuffer(templateBuffer, 'pptx', input.data || {}, maxOutputBytes);
  const readback = readPptxSummary(outBuf, maxOutputBytes);
  const written = writeTempVerified(input.tempPath, input.tempIdentity, outBuf);
  return {
    ...written,
    slideCount: readback.slideCount,
    slides: readback.slides,
    mode: 'template',
    templateSha256: crypto.createHash('sha256').update(templateBuffer).digest('hex'),
    workerExitCode: 0,
  };
}

(async () => {
  try {
    if (!workerData || !['create_presentation_layouts', 'fill_presentation_template'].includes(workerData.action)) {
      throw fail('A9_OFFICE_FORMAT_UNSUPPORTED');
    }
    const result = workerData.action === 'create_presentation_layouts'
      ? await createFromLayouts(workerData)
      : await fillTemplatePptx(workerData);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    const code = /^A9_OFFICE_[A-Z0-9_]+$/.test(String(error && error.code ? error.code : ''))
      ? error.code
      : 'A9_OFFICE_REPORT_FAILED';
    parentPort.postMessage({ ok: false, error: { code, message: String(error && error.message ? error.message : code).slice(0, 300) } });
  } finally {
    parentPort.close();
  }
})();
