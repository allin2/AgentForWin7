import * as fs from 'fs';
import * as path from 'path';

const cardRenderersSource = fs.readFileSync(path.join(__dirname, '../../product/renderer/a9-card-renderers.js'), 'utf8');

/**
 * C1：workbench.html 先加载 a9-card-renderers.js，再加载 a9-workbench.js。
 * 整份脚本在 VM 里运行的测试按同一顺序拼接，使卡片渲染器绑定到测试自己的 window / document。
 */
export function withCardRenderers(workbenchSource: string): string {
  return `${cardRenderersSource}\n${workbenchSource}`;
}
