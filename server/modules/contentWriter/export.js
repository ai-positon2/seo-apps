const cheerio = require('cheerio');
const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, Table, TableRow, TableCell, HeadingLevel, WidthType, LevelFormat } = require('docx');
const { cleanHtml } = require('./document');

async function exportDocx(document, stage) {
  const numbering = [];
  function inline(nodes, style = {}) {
    return nodes.flatMap(node => {
      if (node.type === 'text') return [new TextRun({ text: node.data, ...style })];
      if (node.name === 'br') return [new TextRun({ text: '', break: 1 })];
      const next = { ...style, ...(['b', 'strong'].includes(node.name) ? { bold: true } : {}),
        ...(['i', 'em'].includes(node.name) ? { italics: true } : {}), ...(node.name === 'u' ? { underline: {} } : {}) };
      const children = inline(node.children || [], next);
      if (node.name === 'a' && /^https?:\/\//.test(node.attribs?.href || '')) return [new ExternalHyperlink({ children, link: node.attribs.href })];
      return children;
    });
  }
  function blocks(nodes, list = null) {
    return nodes.flatMap(node => {
      if (node.type === 'text') return node.data.trim() ? [new Paragraph({ children: inline([node]) })] : [];
      if (node.name === 'table') {
        const rows = [];
        const collectRows = items => items.forEach(n => { if (n.name === 'tr') rows.push(n); else collectRows(n.children || []); });
        collectRows(node.children || []);
        return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: rows.map(row => new TableRow({
          children: (row.children || []).filter(c => ['td', 'th'].includes(c.name)).map(c => new TableCell({
            columnSpan: Math.max(1, Math.min(20, Number(c.attribs?.colspan) || 1)),
            rowSpan: Math.max(1, Math.min(100, Number(c.attribs?.rowspan) || 1)),
            children: blocks(c.children || []).length ? blocks(c.children || []) : [new Paragraph('')],
          })),
        })) })];
      }
      if (['ul', 'ol'].includes(node.name)) {
        const reference = `list-${numbering.length}`;
        if (node.name === 'ol') numbering.push({ reference, levels: [{ level: 0, format: LevelFormat.DECIMAL,
          text: '%1.', start: Number(node.attribs?.start) || 1, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] });
        return blocks(node.children || [], node.name === 'ol' ? { numbering: { reference, level: 0 } } : { bullet: { level: 0 } });
      }
      if (node.name === 'li') {
        const children = node.children || [];
        const textNodes = children.filter(n => !['ul', 'ol'].includes(n.name));
        return [new Paragraph({ children: inline(textNodes), ...list }), ...blocks(children.filter(n => ['ul','ol'].includes(n.name)))];
      }
      const headings = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3,
        h4: HeadingLevel.HEADING_4, h5: HeadingLevel.HEADING_5, h6: HeadingLevel.HEADING_6 };
      if (headings[node.name] || ['p','blockquote'].includes(node.name)) return [new Paragraph({
        children: inline(node.children || []), heading: headings[node.name], spacing: { after: 140 },
      })];
      return blocks(node.children || []);
    });
  }
  let children;
  if (stage === 'brief') {
    const b = document.brief;
    function guidance(text) {
      return text.split('\n').filter(line => line.trim() && !/^---+$/.test(line.trim())).map(line => {
        const bullet = /^\s*[-*] /.test(line);
        const runs = line.replace(/^\s*[-*] /, '').split(/(\*\*.*?\*\*)/).map(part => new TextRun({
          text: part.replace(/^\*\*|\*\*$/g, ''), bold: part.startsWith('**'),
        }));
        return new Paragraph({ children: runs, ...(bullet ? { bullet: { level: 0 } } : {}), spacing: { after: 100 } });
      });
    }
    children = [new Paragraph({ text: b.title, heading: HeadingLevel.HEADING_1 }), ...guidance(b.intro),
      ...b.sections.flatMap(s => [new Paragraph({ text: s.heading, heading: HeadingLevel[`HEADING_${s.level.slice(1)}`] || HeadingLevel.HEADING_2 }), ...guidance(s.guidance)]),
      new Paragraph({ text: 'Reference URLs', heading: HeadingLevel.HEADING_2 }), ...guidance(b.references)];
  } else {
    const $ = cheerio.load(cleanHtml(document.draftHtml), null, false);
    children = blocks($.root().contents().toArray());
  }
  return Packer.toBuffer(new Document({ numbering: { config: numbering },
    styles: { default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 140 } } } } },
    sections: [{ children: children.length ? children : [new Paragraph('')] }] }));
}
module.exports = { exportDocx };
