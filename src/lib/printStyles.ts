/**
 * PDF 导出的打印样式（单一来源）：
 * - 应用启动时注入 <style id="qn-print-style">（配合 @media print 的打印对话框流程）；
 * - 「导出 PDF 文件」时嵌入独立 HTML，交给无头浏览器生成 PDF。
 * 修改打印排版改这里；styles.css 里不再保留这一段。
 */
export const PRINT_CSS = `
@media print {
  @page {
    margin: 16mm 14mm;
  }

  /* height:100% 的 body 会把第一页占成整页空白，打印时必须放开 */
  html,
  body,
  #root {
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }

  .app,
  #root,
  #qn-bg-layer,
  .banner {
    display: none !important;
  }

  /* callout（PDF 导出） */
  #qn-print-root .qn-print-callout {
    border-left: 3px solid #7c93b8;
    background: #f1f4f8;
    border-radius: 3px 8px 8px 3px;
    margin: 0.6em 0;
    padding: 0.35em 0.9em;
    page-break-inside: avoid;
  }

  #qn-print-root .qn-print-callout-title {
    font-weight: 650;
    color: #35507c;
    margin-bottom: 0.2em;
  }

  #qn-print-root .qn-print-mermaid {
    text-align: center;
    margin: 0.8em 0;
    page-break-inside: avoid;
  }

  #qn-print-root .qn-print-mermaid svg {
    max-width: 100%;
    height: auto;
  }

  #qn-print-root {
    display: block !important;
    color: #1f2328;
    font-family: var(--font-text);
    font-size: 13.5px;
    line-height: 1.75;
  }

  #qn-print-root h1 { font-size: 1.85em; margin: 0.7em 0 0.35em; line-height: 1.3; }
  #qn-print-root h2 { font-size: 1.5em; margin: 0.7em 0 0.35em; line-height: 1.35; }
  #qn-print-root h3 { font-size: 1.25em; margin: 0.6em 0 0.3em; }
  #qn-print-root h4, #qn-print-root h5, #qn-print-root h6 { margin: 0.6em 0 0.25em; }

  #qn-print-root p { margin: 0.45em 0; }

  #qn-print-root code {
    font-family: var(--mono);
    font-size: 0.88em;
    background: #f1f2f4;
    border-radius: 4px;
    padding: 0.1em 0.35em;
  }

  #qn-print-root pre {
    background: #f6f7f9;
    border: 1px solid #e2e4e8;
    border-radius: 8px;
    padding: 10px 14px;
    white-space: pre-wrap;
    word-break: break-word;
    page-break-inside: avoid;
  }

  #qn-print-root pre code {
    background: none;
    padding: 0;
    font-size: 0.92em;
  }

  #qn-print-root table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.6em 0;
    page-break-inside: avoid;
  }

  #qn-print-root th,
  #qn-print-root td {
    border: 1px solid #d6d9de;
    padding: 5px 10px;
    text-align: left;
  }

  #qn-print-root thead th {
    background: #eef1f4;
  }

  #qn-print-root blockquote {
    border-left: 3px solid #b8c4d4;
    margin: 0.6em 0;
    padding: 0.1em 0.9em;
    color: #4a5160;
  }

  #qn-print-root img {
    max-width: 100%;
    page-break-inside: avoid;
  }

  #qn-print-root .cm-lp-link {
    color: #2f78c2;
  }

  #qn-print-root hr {
    border: none;
    border-top: 1px solid #d9dce1;
    margin: 1em 0;
  }

  #qn-print-root ul,
  #qn-print-root ol {
    padding-left: 1.6em;
  }
}
`;
