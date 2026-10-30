/**
 * dsh-ollama-statistical —— 浏览器端 bundle（经 window.__ModuleLoader__ 加载）。
 *
 * 三处界面：
 *  1. sidebar.panellist     —— 侧栏面板入口图标（原创 SVG，跟随侧栏 currentColor）。
 *  2. main (key: ollama-statistical)
 *                          —— 完整统计页：A 限额、B 本机 token 统计、C 官方用量。
 *  3. sidebar.footer.action —— 侧栏底部常驻双横条（会话 5h 淡蓝 / 本周深蓝）。
 *
 * 数据通道：Host 在 webServer 注册的 /ollama-statistical 前缀路由，经 Connection
 * RPC 信封协议调用（snapshot / refresh / auth-state / set-key / clear-key）。
 * 契约见 .dev/protocol.md；本文件不新增任何 RPC，视图统计全部由 tokens.days 在
 * 客户端切片求和。
 *
 * 呈现层：手写 <style> 幂等注入，颜色 / 字体 / 圆角 / 焦点环全部来自官方
 * --dsw-* 主题变量，亮暗主题自动成立。唯一保留的硬编码颜色是数据可视化蓝色系
 * （#7fb2f9 淡蓝 / #2563eb 深蓝），只用于横条与图表填充。
 *
 * 约束：只 require('react')；禁止 require 任何 @deepseek-ai/* 包（会崩槽位）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ollama-statistical',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const BUNDLE_ID = 'dsh-ollama-statistical'
    const RPC_CHANNEL = '/ollama-statistical'
    const CSS_TAG_ID = BUNDLE_ID + '/client.css'
    const PLUGIN_VERSION = '0.9.4'

    // 数据可视化强调色：只用于侧栏双横条与图表填充，不扩散到任何通用控件。
    // 底色统一走语义色（充足绿 / 偏高黄 / 快用完红），见下方 toneFill()。
    // 排行类占比条的多色调色板（模型榜 / 供应商分布按行轮换），整体更丰富。
    const VIZ_PALETTE = ['#4f8ff7', '#22b573', '#17b4c8', '#f0a24a', '#e35c8a', '#7c8cf8']

    // 多序列趋势图色板（数据可视化专用色，五色区分；不用于通用控件）。
    const TREND_COLORS = {
      input: '#4f8ff7',
      output: '#22b573',
      cacheRead: '#17b4c8',
      cacheWrite: '#f0a24a',
      hitRate: '#e35c8a',
    }

    /* ══════════════════════════════════════════════════════════════
     * 样式（幂等注入；只引用 --dsw-* 主题变量）
     * ══════════════════════════════════════════════════════════════ */

    const CSS = [
      // ── 页面骨架 ───────────────────────────────────────────────
      '.osta-page{display:flex;flex-direction:column;gap:9px;height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 16px 14px;width:100%;max-width:none;margin:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}',
      '.osta-page *{box-sizing:border-box}',
      '.osta-body{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:10px;align-items:stretch;min-width:0}.osta-col{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0}.osta-col>.osta-section{flex:0 0 auto;min-height:0}.osta-col>.osta-section:first-child{flex:1 1 auto;min-height:0}.osta-col>.osta-section:first-child>.osta-card{flex:1 1 auto;min-height:0}.osta-span{grid-column:1/-1;min-width:0}',
      '.osta-header{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;flex-wrap:wrap}',
      '.osta-header-main{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.osta-title{margin:0;font:var(--dsw-font-s-14);font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:-.005em}',
      '.osta-sub{margin:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.osta-header-side{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '.osta-updated{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.osta-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',

      // ── 按钮 / 徽标 ────────────────────────────────────────────
      '.osta-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font:var(--dsw-font-xxs-strong-12);font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}',
      '.osta-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.osta-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.osta-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.osta-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.osta-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.osta-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.osta-btn-primary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.osta-btn-sm{height:24px;padding:0 9px;font:var(--dsw-font-xxxs-strong-11)}',
      '.osta-btn-icon{width:28px;padding:0}',
      '.osta-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font:var(--dsw-font-xxxs-strong-11);font-weight:500;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:100%}',
      '.osta-chip[data-tone=ok]{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
      '.osta-chip[data-tone=warn]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.osta-chip[data-tone=error]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.osta-chip[data-tone=idle]{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-tertiary)}',

      // ── 分区 / 卡片 ────────────────────────────────────────────
      '.osta-section{display:flex;flex-direction:column;gap:7px;min-width:0}',
      '.osta-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;flex-wrap:wrap}',
      '.osta-section-title{display:inline-flex;align-items:center;gap:8px;font:var(--dsw-font-xxs-strong-12);font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;min-width:0}',
      '.osta-section-icon{display:block;flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.osta-section-meta{display:inline-flex;align-items:center;gap:6px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);min-width:0;flex-wrap:wrap}',
      '.osta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;min-width:0}',
      '.osta-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}',
      '.osta-card{display:flex;flex-direction:column;gap:6px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.osta-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}',
      '.osta-card-main{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.osta-card-title{font:var(--dsw-font-xxs-strong-12);font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.osta-card-sub{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:16px}',

      // ── 限额卡 ────────────────────────────────────────────────
      '.osta-limit-values{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;min-width:0}',
      '.osta-limit-primary{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.osta-bignum{font-size:23px;line-height:1.05;font-weight:640;font-variant-numeric:tabular-nums;letter-spacing:-.015em;color:var(--dsw-alias-label-primary)}',
      '.osta-bigpct{font-size:14px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-left:1px}',
      '.osta-limlabel{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.osta-limsecondary{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.osta-track{height:8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,var(--dsw-alias-bg-layer-2));overflow:hidden}',
      '.osta-track-sm{height:5px}',
      '.osta-fill{height:100%;border-radius:999px;transition:width .25s ease,background-color .2s ease}',
      '.osta-note{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);min-width:0}',
      '.osta-note-item{font-variant-numeric:tabular-nums;min-width:0}',
      '.osta-card-headline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.osta-card-side{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none;min-width:0;max-width:62%}',
      '.osta-estimate-inline{display:inline-flex;align-items:center;margin:0;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;width:fit-content;max-width:100%;cursor:help;text-align:right;line-height:15px;white-space:normal}',

      // ── A 区左右两组：Ollama 限额 / OpenCode Go 限额 ───────────
      // ≥1240px 两列并排（align-items:start 让右侧不被左侧 KeyBar 高度拉伸）；
      // <1240px 单列堆叠（A 区两栏在半宽下会把 OpenCode 三卡挤成竖排 / Ollama 标题折行），
      // 整页 .osta-body 的双栏断点仍是 980px（见文件末尾媒体查询）。
      '.osta-limits-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:start;min-width:0}',
      // A 区变成半宽后，Ollama 周卡的「估算总量…」胶囊会挤压标题（标题被省略号截断）。
      // 收紧侧栏宽度让胶囊自己换行，同时允许 A 区卡片标题换行而不是截断；
      // 状态 chip 仍固定在右上角，其它区域卡片布局完全不变。
      '.osta-limits-pair .osta-card-side{max-width:52%}',
      '.osta-limits-pair .osta-card-title{white-space:normal;overflow:visible;text-overflow:clip}',
      // OpenCode 三张窗口卡：宽度够时一行三列，不够时自动折行，不需要额外断点。
      // 150px 太窄：A 区两列时（约 500px 宽的右栏）三张卡会挤成 3×160px，标题换行、重置文案断词。
      // 180px 起：1440 宽（右栏约 595px）可三卡一行（每张约 190px），更窄时自动 2+1 折行。
      '.osta-oc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:7px;min-width:0}',
      // 重置倒计时/重置时间整段换行，不要在多字词中间断开。
      '.osta-limits-pair .osta-note-item{white-space:nowrap}',
      // v0.9.3：本机 opencode CLI 用量改为全宽三卡（复用官方用量卡版式），这里只留区块 hook。
      '.osta-oc-local-section{min-width:0}',
      '.osta-oc-note{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:15px;min-width:0}',
      '.osta-note-status{color:var(--dsw-alias-label-tertiary)}',

      // ── Key 配置面板（v0.9：Key 可选，从页头展开）────────────
      // 复用 .osta-keybar / .osta-card 的视觉语言，只为未配置的 provider 渲染 KeyBar；
      // 两个都缺时双列（≥~640px），窄屏自动堆叠。
      '.osta-keypanel{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.osta-keypanel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0}',
      '.osta-keypanel-main{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.osta-keypanel-title{font:var(--dsw-font-xxs-strong-12);font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.osta-keypanel-sub{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:16px}',
      '.osta-keypanel-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px;align-items:start;min-width:0}',
      '.osta-keypanel .osta-keybar{padding:10px 12px;gap:8px}',
      '.osta-keypanel-hint{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:15px}',
      // v0.9.1：OpenCode 被插件级移除后，面板里的「恢复外部 Key」提示块
      '.osta-keypanel-col{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.osta-keypanel-notice{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 6%,transparent);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);line-height:16px;min-width:0}',
      '.osta-keypanel-notice-text{flex:1 1 220px;min-width:0}',

      // ── 页头 provider 显示开关（v0.9.2）──────────────────────
      // 复用 .osta-btn 风格；关闭态弱化（虚线边框 + 灰色 + 名称删除线 + 灰点），只用 --dsw-* 变量。
      '.osta-toggles{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.osta-toggle{gap:5px}',
      '.osta-toggle[aria-pressed=false]{color:var(--dsw-alias-label-tertiary);border-style:dashed}',
      '.osta-toggle[aria-pressed=false] .osta-toggle-name{text-decoration:line-through}',
      '.osta-toggle[aria-pressed=true]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2))}',
      '.osta-toggle-dot{width:5px;height:5px;border-radius:999px;flex:none;background:var(--dsw-alias-state-success-primary)}',
      '.osta-toggle[aria-pressed=false] .osta-toggle-dot{background:var(--dsw-alias-state-idle-primary)}',

      // ── Tab / 日期范围 ────────────────────────────────────────
      '.osta-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}',
      '.osta-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}',
      '.osta-tab{height:24px;padding:0 10px;border:none;border-radius:calc(var(--dsw-radius-sm) - 1px);background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-strong-11);font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .15s ease,color .15s ease}',
      '.osta-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.osta-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}',
      '.osta-tab[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}',
      '.osta-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.osta-chiprow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}',
      '.osta-range{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.osta-field{display:inline-flex;align-items:center;gap:6px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.osta-input{height:28px;padding:0 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums;transition:border-color .15s ease}',
      '.osta-input:hover{border-color:var(--dsw-alias-border-l3)}',
      '.osta-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.osta-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.osta-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.osta-input[type=date]{min-width:132px}',
      '.osta-input-wide{flex:1 1 220px;min-width:0;width:100%}',

      // ── 统计总数 / 指标网格 ────────────────────────────────────
      '.osta-total{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;min-width:0}',
      '.osta-total-value{font-size:27px;line-height:1;font-weight:660;font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--dsw-alias-label-primary)}',
      '.osta-total-unit{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.osta-total-meta{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.osta-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:6px;min-width:0}',
      '.osta-metric{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.osta-metric-label{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.osta-metric-value{font:var(--dsw-font-xs-strong-13);font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      // ── 多序列趋势图（SVG）────────────────────────────────────
      '.osta-trend{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.osta-trend-plot{position:relative;min-width:0}',
      '.osta-trend-hit{fill:transparent;cursor:crosshair;outline:none}',
      '.osta-trend-hit:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.osta-trend-guide{stroke:var(--dsw-alias-border-l3);stroke-width:1;stroke-dasharray:3 3;pointer-events:none}',
      '.osta-trend-tip{position:absolute;z-index:3;pointer-events:none;display:flex;flex-direction:column;gap:3px;min-width:168px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 18px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxxs-11)}',
      '.osta-trend-tip-time{font:var(--dsw-font-xxxs-strong-11);font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:2px;white-space:nowrap}',
      '.osta-trend-tip-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '.osta-trend-tip-label{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.osta-trend-tip-value{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap}',
      '.osta-trend-tip-dot{width:6px;height:6px;border-radius:999px;flex:none}',
      '.osta-trend-legend{display:flex;align-items:center;justify-content:center;gap:2px 10px;flex-wrap:wrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);min-width:0}',
      '.osta-trend-legenditem{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;min-width:0}',
      '.osta-trend-dot{width:7px;height:7px;border-radius:999px;flex:none}',
      '.osta-trend-svg{display:block;width:100%;height:auto;min-width:0}',
      '.osta-trend-grid{stroke:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent);stroke-width:1.2;stroke-dasharray:4 5}',
      '.osta-trend-baseline{stroke:var(--dsw-alias-border-l2);stroke-width:1}',
      '.osta-trend-line{fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
      '.osta-trend-line[data-series=hitRate]{stroke-width:2.6}',
      '.osta-trend-area{stroke:none}',
      '.osta-trend-point{stroke:none}',
      '.osta-trend-point[data-active=true]{stroke:var(--dsw-alias-bg-layer-1);stroke-width:1.5}',
      '.osta-trend-point[data-series=hitRate]{stroke:var(--dsw-alias-bg-l1,#fff);stroke-width:1.4}',
      '.osta-trend-axislabel{fill:var(--dsw-alias-label-tertiary);font-size:12px;font-family:inherit;font-variant-numeric:tabular-nums}',
      '.osta-trend-axislabel-rate{fill:#e35c8a;font-weight:600}',

      // ── 模型分布 ──────────────────────────────────────────────
      '.osta-models{display:flex;flex-direction:column;gap:0;min-width:0}',
      '.osta-model{position:relative;display:flex;align-items:center;gap:8px;padding:3px 8px;border-radius:6px;overflow:hidden;min-width:0}',
      '.osta-model:last-child{border-bottom:none}',
      '.osta-model-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}',
      '.osta-model-title{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto}',
      '.osta-model-name{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}',
      '.osta-model-provider{flex:none;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.osta-model-meta{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.osta-model-value{font:var(--dsw-font-xxs-strong-12);font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.osta-model-bar{position:absolute;left:0;top:0;bottom:0;border-radius:6px;opacity:.16;pointer-events:none}',
      '.osta-model + .osta-model{margin-top:1px}',
      '.osta-model-title{position:relative;z-index:1}',
      '.osta-model-value{position:relative;z-index:1;flex:none}',

      // ── 官方用量 ──────────────────────────────────────────────
      '.osta-spark{display:flex;align-items:flex-end;gap:2px;height:26px;width:100%;min-width:0}',
      '.osta-sparkbar{flex:1 1 0;min-width:1px;min-height:2px;border-radius:1px;background:linear-gradient(180deg,#67e8f9,#17b4c8)}',
      '.osta-sparkbar[data-partial=true]{background:#0d9488}',
      '.osta-official-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}',
      '.osta-official-num{font-size:21px;line-height:1.05;font-weight:640;font-variant-numeric:tabular-nums;letter-spacing:-.015em}',
      '.osta-mini-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px;min-width:0}',
      '.osta-mini{padding:6px 8px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.osta-mini-label{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.osta-mini-value{font:var(--dsw-font-xxs-strong-12);font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      // ── Key 引导 / 输入 ───────────────────────────────────────
      '.osta-keybar{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 6%,var(--dsw-alias-bg-layer-1))}',
      '.osta-keybar-head{display:flex;align-items:flex-start;gap:10px;min-width:0}',
      '.osta-keybar-icon{display:block;flex:none;color:var(--dsw-alias-state-warn-primary)}',
      '.osta-keybar-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.osta-keybar-title{font:var(--dsw-font-xxs-strong-12);font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.osta-keybar-sub{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:16px}',
      '.osta-keyform{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.osta-guide .osta-steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);line-height:18px}',
      '.osta-link{color:var(--dsw-alias-link);text-decoration:none;border-radius:var(--dsw-radius-xs)}',
      '.osta-link:hover{text-decoration:underline}',
      '.osta-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.osta-error{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);line-height:18px;word-break:break-word}',
      '.osta-errorbar{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 24%,transparent);border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);line-height:18px;word-break:break-word}',
      '.osta-errorbar-icon{display:block;flex:none;margin-top:2px}',

      // ── 空态 / 骨架 / 页脚 ────────────────────────────────────
      '.osta-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:26px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);text-align:center;min-width:0}',
      '.osta-empty-title{font:var(--dsw-font-xxs-strong-12);font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.osta-empty-sub{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:16px;max-width:520px}',
      '.osta-skeleton{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.osta-sk{height:12px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton)}',
      '.osta-sk-card{height:104px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-skeleton)}',
      '.osta-footer{display:flex;flex-direction:column;gap:4px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:14px;min-width:0}',
      '.osta-errors{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none;min-width:0}',
      '.osta-erroritem{display:flex;align-items:baseline;gap:6px;min-width:0;word-break:break-word}',
      '.osta-errorcode{font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-state-error-primary);flex:none;font-variant-numeric:tabular-nums}',
      '.osta-partial{display:inline-flex;align-items:center;align-self:flex-start;gap:6px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);font:var(--dsw-font-xxxs-strong-11);font-weight:500}',
      '.osta-dismiss{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;margin-left:2px;border:none;border-radius:999px;background:transparent;color:inherit;font:inherit;line-height:1;cursor:pointer;opacity:.65;flex:none}',
      '.osta-dismiss:hover{opacity:1;background:color-mix(in srgb,currentColor 14%,transparent)}',
      '.osta-dismiss:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.osta-partial[data-tone=info]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.osta-status-list{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}',
      '.osta-version{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-caption);flex-wrap:wrap}',

      // ── 侧栏双横条 ────────────────────────────────────────────
      // 侧栏 footer 的动作区是 display:flex 的单行容器（footerActions），里面还有
      // 其他图标按钮；这里让双横条占满「除图标外」的剩余宽度，并强制自身溢出隐藏，
      // 避免文字/进度条被挤出侧栏。若宿主容器允许换行（下方带保护的选择器），
      // 双横条会独占一整行，从而稳定拿到完整侧栏宽度。
      '.osta-bars{display:flex;flex-direction:column;gap:7px;padding:6px 0 4px;flex:1 1 100%;width:100%;min-width:0;max-width:100%;overflow:hidden;box-sizing:border-box;background:transparent;border:none}',
      '[class*="footerActions"]{flex-wrap:wrap;align-items:center;row-gap:2px}',
      '.osta-barsrow{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.osta-barshead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}',
      '.osta-barslabel{display:inline-flex;align-items:center;gap:5px;flex:1 1 auto;min-width:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.osta-barsdot{width:5px;height:5px;border-radius:999px;flex:none;background:var(--osta-fill,#17b4c8)}',
      '.osta-barsval{flex:none;font:var(--dsw-font-xxxs-strong-11);font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap;min-width:34px;text-align:right}',
      '.osta-minibar{height:5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);overflow:hidden}',
      '.osta-minibarfill{height:100%;border-radius:999px;background:var(--osta-fill,#17b4c8);transition:width .3s cubic-bezier(.2,.7,.3,1),background-color .2s ease}',
      '.osta-barsrow[data-tone=warn] .osta-barsval{color:var(--dsw-alias-state-warn-primary)}',
      '.osta-barsrow[data-tone=error] .osta-barsval{color:var(--dsw-alias-state-error-primary)}',
      '.osta-barsempty{display:inline-flex;align-items:center;gap:6px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.osta-barsempty::before{content:"";width:5px;height:5px;border-radius:999px;flex:none;background:var(--dsw-alias-state-idle-primary)}',

      // ── 响应式 / 动效收敛 ────────────────────────────────────
      // A 区两栏在 ~1100-1240px 时右栏过窄（OpenCode 三卡会竖排、Ollama 标题折行）→ 提前合并单列；
      // 页面主体双栏仍按 980px 断点，二者互不影响。
      '@media (max-width:1240px){.osta-limits-pair{grid-template-columns:minmax(0,1fr)}}',
      '@media (max-width:980px){.osta-body{grid-template-columns:minmax(0,1fr)}}',
      '@media (max-width:720px){.osta-page{padding:16px 14px 24px;gap:14px}.osta-grid,.osta-grid-3{grid-template-columns:minmax(0,1fr)}.osta-bignum{font-size:22px}.osta-total-value{font-size:26px}.osta-official-num{font-size:22px}.osta-grid-3 .osta-card{padding:14px}}',
      '@media (prefers-reduced-motion:reduce){.osta-fill,.osta-minibarfill{transition:none}}',
    ].join('\n')

    /**
     * 注入样式（幂等）。返回本次新建的 <style> 元素；已存在或没有 document 时返回 null。
     * 返回元素让 apply 能在 ctx.effect 的清理函数里把它移除。
     */
    function injectCss() {
      if (typeof document === 'undefined') return null
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return null
      const tag = document.createElement('style')
      tag.dataset.plugin = BUNDLE_ID
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      ;(document.head || document.documentElement).appendChild(tag)
      return tag
    }

    /* ══════════════════════════════════════════════════════════════
     * i18n 字典
     * ══════════════════════════════════════════════════════════════ */

    const DICT_ZH = {
      'panel.label': 'Token 统计',

      'app.title': 'Token 统计',
      'app.subtitle': '本机 token 统计（按供应商） · Ollama / OpenCode 限额（配置 Key 后显示）',
      'app.refresh': '刷新',
      'app.refreshing': '刷新中…',
      'app.updated': '更新于 {time}',
      'app.autoRefresh': '每 60 秒自动刷新',
      'app.cached': '缓存数据',
      'app.retry': '重试',
      'app.loadFailed': '加载失败',

      'limits.title': 'Ollama 限额',
      'limits.session': '会话限额（每 5 小时）',
      'limits.weekly': '本周限额（Weekly）',
      'limits.used': '已用',
      'limits.remaining': '剩余',
      'limits.resetIn': '还有 {time} 重置',
      'limits.resetAt': '重置时间 {time}',
      'limits.resetUnknown': '重置时间未知',
      'limits.weekNote': '每周一 00:00（UTC）开始新的一周',
      'limits.estimateCompact': '估算总量 {total} · 已用 {used} · 剩余 {remaining}',
      'limits.estimateHint': '按「本机 Ollama token 用量 ÷ 官方周限额已用百分比」反推；若该 Key 还在其它客户端使用，或历史统计尚未补齐，估算会偏小。',
      'limits.sessionNote': '每 5 小时一个窗口 · 本窗口 {start} 开始（本地时间）',
      'limits.sessionNotePlain': '每 5 小时一个窗口（自上次重置起算）',
      'limits.none': '当前套餐没有返回限额字段',
      'limits.creditsTitle': '订阅额度',
      'limits.creditAllowance': '额度 {usd}',
      'limits.period': '周期 {from} — {until}',
      'limits.purchased': '购买余额 {usd}',
      'limits.keySource': 'Key 来源：{source} · {masked}',
      'limits.tone.ok': '充足',
      'limits.tone.warn': '偏高',
      'limits.tone.error': '接近上限',
      'limits.tone.idle': '无数据',
      'limits.clearManual': '清除手动 Key',
      'limits.clearing': '清除中…',
      'limits.editKey': '更换 Key',

      'source.credentials': 'DSH 凭证库',
      'source.env': '环境变量',
      'source.local-cli': '本地 CLI 登录',
      'source.manual': '手动填写',
      'source.none': '未配置',

      'key.title': '未检测到 Ollama API Key',
      'key.desc': '限额与官方用量需要一个 Ollama Cloud API Key。Key 只在本机 Host 进程内使用，浏览器端只能看到脱敏后的末 4 位。',
      'key.step1': '在 DSH 设置 → 模型服务商 里为 Ollama 配置凭证 OLLAMA_API_KEY（推荐）；',
      'key.step2': '或在启动 DSH 的环境里设置 OLLAMA_API_KEY，或先在终端执行 ollama signin 登录；',
      'key.step3': '也可以直接粘贴一个 Key 到下方，点击「检测并保存」后写入本机状态文件。',
      'key.persist': '手动 Key 仅当前用户可读，保存在 $DSH_HOME/storages/ollama-statistical/state.json，可随时清除。',
      'key.placeholder': '粘贴 Ollama API Key（sk-…）',
      'key.label': 'Ollama API Key',
      'key.submit': '检测并保存',
      'key.submitting': '检测中…',
      'key.barTitle': '未配置 Ollama API Key',
      'key.barSub': '限额与官方用量不可用；本机 token 统计仍可查看。填入 Key 后立即解锁。',
      'key.none': 'Key 未配置',
      'key.cancel': '取消',
      'key.changeTitle': '更换 Ollama API Key',
      'key.changeSub': '粘贴新 Key 并保存会覆盖当前使用的 Key（旧 Key 不再使用）；手动 Key 会优先于 DSH 凭证库生效，点「清除手动 Key」即可恢复使用 DSH 凭证。',
      // v0.9：Key 可选，页头「配置 Key」按钮 + 内联配置面板
      'key.config': '配置 Key',
      'key.panelTitle': '配置 API Key',
      'key.panelSub': 'Ollama / OpenCode 的 Key 都不是必填项：不配置时页面只显示本机 token 统计；配置后解锁对应 provider 的限额与官方用量。',
      'key.ollamaBarTitle': '配置 Ollama API Key',
      'key.ollamaBarSub': '限额与官方用量需要一个 Ollama Cloud API Key；DSH 凭证 OLLAMA_API_KEY、环境变量或 ollama signin 登录也可以。',
      'key.opencodeBarTitle': '配置 OpenCode API Key',
      'key.opencodeBarSub': '优先复用 opencode CLI 登录的 Key（~/.local/share/opencode/auth.json），也可手动粘贴；仅 Go 订阅会返回额度窗口。',
      'key.close': '关闭',
      'key.panelHint': '已配置的 provider 可在页面上方的限额区里「更换 Key」或「清除手动 Key」。',
      // v0.9.2：按 provider 显示开关（不删除 Key）
      'visibility.label': '显示范围',
      'visibility.ollama': 'Ollama',
      'visibility.opencode': 'OpenCode',
      'visibility.hint': '只显示需要关注的 provider（不会删除任何 Key；下方本机 token 统计始终包含全部供应商）',
      'visibility.toggleOn': '已显示：点击隐藏 {provider}',
      'visibility.toggleOff': '已隐藏：点击显示 {provider}',

      'tokens.title': '本机 token 统计（全部供应商）',
      'tokens.subtitle': 'DSH 会话日志 · 按供应商分类',
      'tokens.window': '统计窗口 {from} — {to}',
      'tokens.tabToday': '今天',
      'tokens.tabWeek': '本周（周一开始）',
      'tokens.tabCustom': '自定义',
      'tokens.from': '开始',
      'tokens.to': '结束',
      'tokens.total': '总 token',
      'tokens.input': '输入',
      'tokens.output': '输出',
      'tokens.cacheRead': '缓存读',
      'tokens.cacheWrite': '缓存创建',
      'tokens.cacheHit': '缓存命中',
      'tokens.hitRate': '缓存命中率',
      'tokens.cacheHitHint': '缓存命中率 = 缓存读 {hit} /（输入 {input} + 缓存读）',
      'tokens.reasoning': '推理',
      'tokens.requests': '请求次数',
      'tokens.activeDays': '活跃天数',
      'tokens.sessions': '会话数',
      'tokens.sessionsHint': '按天累加（同一天内按会话去重）',
      'tokens.chartTitle': '每日 token',
      'tokens.hourlyTitle': '每小时 token',
      'tokens.chartAria': '{from} 至 {to} 的多序列 token 趋势图',
      'tokens.empty': '该区间暂无本地 DSH token 记录',
      'tokens.modelsTitle': '模型分布（当前范围）',
      'tokens.modelsEmpty': '暂无模型记录',
      'tokens.modelsOther': '其余模型',
      'tokens.providerAll': '全部',
      'tokens.providerFilter': '按供应商筛选',
      'tokens.providerTotalsHint': '该供应商缺少逐日明细，以下为近 30 天窗口合计',
      'tokens.windowValueSuffix': '（窗口值）',
      'tokens.noDaily': '该供应商没有逐日明细，以下只显示近 30 天窗口合计',
      'tokens.partial': '扫描未完成，数据可能不完整（可点刷新）',
      'tokens.scanProgress': '正在补齐历史会话 {covered}/{candidates}（后台继续扫描，刷新即可看到更多）',
      'tokens.failed': '{n} 个会话日志读取失败，暂未计入',
      'tokens.ignore': '忽略',
      'tokens.ignoreHint': '不再显示这条提示（读取失败的会话仍不会计入统计）；失败数量变化后会重新提示。',
      'tokens.failedTitle': '这些会话日志读取失败（可能是旧格式或日志损坏），在 DSH 里打开一次对应会话可触发迁移；插件每 6 小时会重试。',
      'tokens.retired': '含 {n} 个已删除会话',
      'tokens.retiredTitle': '这些会话已从 DSH 删除，但插件保留了它们的 token 统计（账本：$DSH_HOME/storages/ollama-statistical/ledger.json，删除该文件可清空）',
      'tokens.unavailable': '未能读取本机会话日志，token 统计不可用',
      'tokens.footer': '数据来源：本机 DSH 会话日志（全部供应商） · 时区 {tz} · 官方接口对 legacy 套餐不返回 token 数',

      'official.title': 'Ollama 官方请求量',
      'official.range24h': '今天',
      'official.range7d': '本周',
      'official.range30d': '本月',
      'official.requests': '次请求',
      'official.input': '输入 token',
      'official.cachedInput': '缓存命中',
      'official.output': '输出 token',
      'official.cost': '费用',
      'official.failed': '获取失败',
      'official.empty': '官方用量数据不可用',
      'official.noKey': '未配置 Ollama API Key，无法读取 Ollama 官方请求量（OpenCode 限额不受影响）。',
      'official.note': '官方口径：UTC 小时 / 日；今天/本周/本月 = UTC 当日 / 周一 / 1 日起（与官方周限额重置周期一致，与官方桶严格对齐）；legacy 套餐仅返回请求次数；含该账号所有客户端，不限于本 Key。',
      'official.utc': 'UTC 口径',
      'official.inProgress': '当前小时/当日进行中',
      'official.noTokens': '该套餐未返回 token 明细',
      'official.window': '{from} — {to}（UTC）',

      'bars.label': 'Token 统计',
      'bars.session': '会话 5h',
      'bars.weekly': '本周',
      'bars.credits': '订阅额度',
      'bars.unconfigured': 'Ollama / OpenCode 未配置',
      'bars.resetSuffix': '（{time}后重置）',
      'bars.updated': '更新于 {time}',
      'bars.tipLead': '用量统计',
      'bars.tipEmpty': '未配置 Ollama / OpenCode API Key，打开「用量统计」页完成配置',
      'bars.opencode': 'OpenCode Go',
      'bars.opencodeDetail': '（{windows}）',

      // ── OpenCode Go（v0.8 增量）───────────────────────────────
      'opencode.title': 'OpenCode Go 限额',
      // 标题保持短（卡片半宽时一行放得下），Rolling/Weekly/Monthly 放进副标题。
      'opencode.rolling': '5 小时窗口',
      'opencode.weekly': '本周限额',
      'opencode.monthly': '本月限额',
      'opencode.rollingSub': '滚动 5 小时窗口（Rolling）',
      'opencode.weeklySub': '每周（Weekly）',
      'opencode.monthlySub': '订阅周期（Monthly）',
      'opencode.statusOk': '状态正常',
      'opencode.statusWarn': '接口状态：{status}',
      'opencode.note': 'OpenCode 只返回额度百分比与重置时间（滚动 5 小时 / 每周 / 每月），不含金额；Zen 按量计费没有官方额度接口，金额只在 OpenCode Console 可见。',
      'opencode.noKey': 'OpenCode 未配置',
      'opencode.barTitle': '未配置 OpenCode Key',
      'opencode.barSub': '优先复用 opencode CLI 登录的 Key（~/.local/share/opencode/auth.json），也可手动粘贴。',
      'opencode.placeholder': '粘贴 OpenCode API Key（sk-…）',
      'opencode.label': 'OpenCode API Key',
      'opencode.changeTitle': '更换 OpenCode API Key',
      'opencode.changeSub': '手动 Key 会覆盖 opencode CLI 登录的 Key（最高优先级，可用于替换已过期的 CLI Key）；点「清除手动 Key」可回退到其它来源。',
      'opencode.editKey': '更换 Key',
      'opencode.clearManual': '清除手动 Key',
      'opencode.clearing': '清除中…',
      // v0.9.1：插件级「移除 Key」（disabled 标志；不删除环境变量 / CLI 登录）
      'opencode.removeKey': '移除 Key',
      'opencode.removing': '移除中…',
      'opencode.removeKeyHint': '插件级停用：不再使用 DSH 凭证、环境变量或 opencode CLI 登录里的 Key；不会删除这些外部配置，可随时「恢复外部 Key」。',
      'opencode.disabledHint': '插件已移除该 Key：不再使用 DSH 凭证 / 环境变量 / CLI 登录里的 Key（外部配置不会被删除）。',
      'opencode.restoreKey': '恢复外部 Key',
      'opencode.restoring': '恢复中…',
      'opencode.restoreHint': '恢复后重新使用 DSH 凭证 / 环境变量 / CLI 登录里的 Key；也可以直接粘贴新 Key（保存即自动恢复）。',
      'opencode.empty': '当前 Key 没有 OpenCode Go 订阅',
      'opencode.emptyHint': '该 Key 未返回 Go 订阅窗口（Zen 按量计费没有官方额度接口）；可点「更换 Key」换用带 Go 订阅的 Key。',
      'opencode.failed': 'OpenCode 额度获取失败',
      'opencode.failedHint': '已保留上次成功采集的额度，点右上角「刷新」可重试。',
      'opencode.localTitle': '本机 opencode CLI 用量',
      'opencode.localHint': '近 {days} 天 · 时区 {tz}',
      'opencode.localToday': '今天',
      'opencode.localWeek': '本周',
      'opencode.localMonth': '本月',
      'opencode.localMeta': '{requests} 次请求',
      'opencode.localTitleAttr': '本机 opencode.db 近 {days} 天口径 · 时区 {tz} · Top 模型：{models} · 与 DSH 会话日志的 token 统计互不混算',
      'opencode.localModelsEmpty': '暂无模型',
      // v0.9.3：本机 CLI 用量三卡
      'opencode.localTokenUnit': 'Token',
      'opencode.localCost': '费用',
      'opencode.localRange': '{from} — {to}',
      'opencode.localNote': '来自本机 opencode.db · 与 DSH 会话日志的 token 统计口径不同（按消息的本地小时/日聚合，含所有 OpenCode 供应商）',
      // v0.9.4：额度卡 token 估算
      'opencode.estimateHint': '按「本机 opencode.db 对应窗口 token 用量 ÷ 官方已用百分比」反推：只统计本机 CLI，其它客户端的用量不计入；历史未补齐时会偏小；滚动 5 小时用最近 5 个本机小时桶近似。估算值不是官方额度，卡片上的百分比与重置时间仍是官方数据。',
      'opencode.keySource': 'Key 来源：{source} · {masked}',
      'opencode.winShort.rolling': '5h',
      'opencode.winShort.weekly': '周',
      'opencode.winShort.monthly': '月',

      'error.noKey': '未配置 Ollama API Key',
      'error.unauthorized': 'Key 无效或已过期（401/403）',
      'error.rateLimit': '官方接口限流，请稍后重试',
      'error.network': '网络请求失败',
      'error.http': '官方接口返回异常',
      'error.noData': '暂无可用数据',
      'error.internal': '插件内部错误',
      'error.badRequest': '请求格式不合法',
      'error.generic': '请求失败',
      'error.sep': '：',

      'time.lessThanMinute': '不到 1 分钟',
      'time.now': '即将重置',
      'time.days': '{n} 天',
      'time.hours': '{n} 小时',
      'time.minutes': '{n} 分钟',
    }

    const DICT_EN = {
      'panel.label': 'Token stats',

      'app.title': 'Token stats',
      'app.subtitle': 'Local token stats (by provider) · Ollama / OpenCode limits (shown after a key is configured)',
      'app.refresh': 'Refresh',
      'app.refreshing': 'Refreshing…',
      'app.updated': 'Updated {time}',
      'app.autoRefresh': 'Auto-refresh every 60s',
      'app.cached': 'Cached',
      'app.retry': 'Retry',
      'app.loadFailed': 'Failed to load',

      'limits.title': 'Ollama limits',
      'limits.session': 'Session limit (5-hour window)',
      'limits.weekly': 'Weekly limit',
      'limits.used': 'Used',
      'limits.remaining': 'Remaining',
      'limits.resetIn': 'Resets in {time}',
      'limits.resetAt': 'Resets at {time}',
      'limits.resetUnknown': 'Reset time unknown',
      'limits.weekNote': 'Weeks start Monday 00:00 UTC',
      'limits.estimateCompact': 'Est. total {total} · used {used} · remaining {remaining}',
      'limits.estimateHint': 'Derived from local Ollama token usage divided by the official weekly used percentage; the estimate is low if the key is used in other clients or the history scan is still incomplete.',
      'limits.sessionNote': '5-hour windows · this window started at {start} (local time)',
      'limits.sessionNotePlain': '5-hour windows (counted from the last reset)',
      'limits.none': 'This plan returned no limit fields',
      'limits.creditsTitle': 'Subscription credit',
      'limits.creditAllowance': 'Allowance {usd}',
      'limits.period': 'Period {from} — {until}',
      'limits.purchased': 'Purchased balance {usd}',
      'limits.keySource': 'Key source: {source} · {masked}',
      'limits.tone.ok': 'Healthy',
      'limits.tone.warn': 'Elevated',
      'limits.tone.error': 'Near limit',
      'limits.tone.idle': 'No data',
      'limits.clearManual': 'Clear manual key',
      'limits.clearing': 'Clearing…',
      'limits.editKey': 'Change key',

      'source.credentials': 'DSH credentials',
      'source.env': 'Environment',
      'source.local-cli': 'Local CLI login',
      'source.manual': 'Entered manually',
      'source.none': 'Not configured',

      'key.title': 'No Ollama API key detected',
      'key.desc': 'Limits and official usage need an Ollama Cloud API key. The key stays inside the local Host process; the browser only ever sees a masked tail.',
      'key.step1': 'Configure OLLAMA_API_KEY for Ollama in DSH settings (recommended);',
      'key.step2': 'or export OLLAMA_API_KEY in the DSH environment, or run ollama signin in a terminal;',
      'key.step3': 'or paste a key below and press “Verify & save” to store it locally.',
      'key.persist': 'A manually entered key is readable only by the current OS user and stored in $DSH_HOME/storages/ollama-statistical/state.json; it can be cleared at any time.',
      'key.placeholder': 'Paste an Ollama API key (sk-…)',
      'key.label': 'Ollama API key',
      'key.submit': 'Verify & save',
      'key.submitting': 'Verifying…',
      'key.barTitle': 'No Ollama API key configured',
      'key.barSub': 'Limits and official usage are unavailable; local token stats still work. Add a key to unlock them.',
      'key.none': 'Key not configured',
      'key.cancel': 'Cancel',
      'key.changeTitle': 'Replace the Ollama API key',
      'key.changeSub': 'Saving a new key overrides the one currently in use. A manual key takes precedence over the DSH credential; press “Clear manual key” to fall back to the DSH credential again.',
      // v0.9: keys are optional; header "Configure keys" button + inline panel
      'key.config': 'Configure keys',
      'key.panelTitle': 'Configure API keys',
      'key.panelSub': 'Ollama / OpenCode keys are both optional: without them the page shows local token stats only; adding one unlocks that provider’s limits and official usage.',
      'key.ollamaBarTitle': 'Configure an Ollama API key',
      'key.ollamaBarSub': 'Limits and official usage need an Ollama Cloud API key; the DSH credential OLLAMA_API_KEY, an environment variable, or ollama signin also works.',
      'key.opencodeBarTitle': 'Configure an OpenCode API key',
      'key.opencodeBarSub': 'The key from the opencode CLI login (~/.local/share/opencode/auth.json) is reused first; you can also paste one. Only Go subscriptions return quota windows.',
      'key.close': 'Close',
      'key.panelHint': 'Configured providers can be changed or cleared from their limits section at the top of the page.',
      // v0.9.2: per-provider visibility toggles (keys are not deleted)
      'visibility.label': 'Visibility',
      'visibility.ollama': 'Ollama',
      'visibility.opencode': 'OpenCode',
      'visibility.hint': 'Show only the providers you need (no key is deleted; the local token stats below always cover all providers)',
      'visibility.toggleOn': 'Shown: click to hide {provider}',
      'visibility.toggleOff': 'Hidden: click to show {provider}',

      'tokens.title': 'Local token stats (all providers)',
      'tokens.subtitle': 'DSH session logs · grouped by provider',
      'tokens.window': 'Window {from} — {to}',
      'tokens.tabToday': 'Today',
      'tokens.tabWeek': 'This week (from Monday)',
      'tokens.tabCustom': 'Custom',
      'tokens.from': 'From',
      'tokens.to': 'To',
      'tokens.total': 'Total tokens',
      'tokens.input': 'Input',
      'tokens.output': 'Output',
      'tokens.cacheRead': 'Cache read',
      'tokens.cacheWrite': 'Cache creation',
      'tokens.cacheHit': 'Cache hit',
      'tokens.hitRate': 'Cache Hit Rate',
      'tokens.cacheHitHint': 'Cache hit rate = cache read {hit} / (input {input} + cache read)',
      'tokens.reasoning': 'Reasoning',
      'tokens.requests': 'Requests',
      'tokens.activeDays': 'Active days',
      'tokens.sessions': 'Sessions',
      'tokens.sessionsHint': 'Summed per day (deduplicated within a day)',
      'tokens.chartTitle': 'Tokens per day',
      'tokens.hourlyTitle': 'Tokens per hour',
      'tokens.chartAria': 'Multi-series token trend from {from} to {to}',
      'tokens.empty': 'No local DSH token records in this range',
      'tokens.modelsTitle': 'Model distribution (current range)',
      'tokens.modelsEmpty': 'No model records',
      'tokens.modelsOther': 'Other models',
      'tokens.providerAll': 'All',
      'tokens.providerFilter': 'Filter by provider',
      'tokens.providerTotalsHint': 'No daily breakdown for this provider; the 30-day window totals are shown below',
      'tokens.windowValueSuffix': ' (window value)',
      'tokens.noDaily': 'No daily breakdown for this provider; only the 30-day window totals are shown',
      'tokens.partial': 'Scan incomplete — numbers may be understated (press Refresh)',
      'tokens.scanProgress': 'Backfilling history {covered}/{candidates} (scanning in background; refresh to see more)',
      'tokens.failed': '{n} sessions could not be read (not counted yet)',
      'tokens.ignore': 'Dismiss',
      'tokens.ignoreHint': 'Hide this notice (the unreadable sessions stay excluded from stats); it reappears if the failure count changes.',
      'tokens.failedTitle': 'These session logs failed to read (old format or corrupted). Open each session once in DSH to trigger migration; the plugin retries every 6 hours.',
      'tokens.retired': 'includes {n} deleted sessions',
      'tokens.retiredTitle': 'These sessions were deleted from DSH, but their token usage is kept in the plugin ledger ($DSH_HOME/storages/ollama-statistical/ledger.json; delete the file to clear it).',
      'tokens.unavailable': 'Could not read the local session log; token stats are unavailable',
      'tokens.footer': 'Source: local DSH session log (all providers) · time zone {tz} · the official API returns no token counts for legacy plans',

      'official.title': 'Ollama official request counts',
      'official.range24h': 'Today',
      'official.range7d': 'This week',
      'official.range30d': 'This month',
      'official.requests': 'requests',
      'official.input': 'Input tokens',
      'official.cachedInput': 'Cache hits',
      'official.output': 'Output tokens',
      'official.cost': 'Cost',
      'official.failed': 'Fetch failed',
      'official.empty': 'Official usage is unavailable',
      'official.noKey': 'No Ollama API key configured, so official Ollama request counts are unavailable (OpenCode limits are unaffected).',
      'official.note': 'Official basis: UTC hours / days; today / this week / this month start at the UTC day / Monday / 1st (matching the official weekly quota reset, exactly aligned with official buckets); legacy plans return request counts only; covers every client on this account, not just this key.',
      'official.utc': 'UTC basis',
      'official.inProgress': 'Current hour/day in progress',
      'official.noTokens': 'This plan returned no token breakdown',
      'official.window': '{from} — {to} (UTC)',

      'bars.label': 'Token stats',
      'bars.session': 'Session 5h',
      'bars.weekly': 'Week',
      'bars.credits': 'Credit',
      'bars.unconfigured': 'Ollama / OpenCode not configured',
      'bars.resetSuffix': ' (resets in {time})',
      'bars.updated': 'updated {time}',
      'bars.tipLead': 'Usage stats',
      'bars.tipEmpty': 'Usage stats: no Ollama / OpenCode API key — open the Usage stats page to configure one',
      'bars.opencode': 'OpenCode Go',
      'bars.opencodeDetail': ' ({windows})',

      // ── OpenCode Go (v0.8) ─────────────────────────────────
      'opencode.title': 'OpenCode Go limits',
      'opencode.rolling': '5-hour window (Rolling)',
      'opencode.weekly': 'Weekly limit',
      'opencode.monthly': 'Monthly limit',
      'opencode.rollingSub': 'Rolling 5-hour window',
      'opencode.weeklySub': 'Weekly',
      'opencode.monthlySub': 'Subscription period',
      'opencode.statusOk': 'Status OK',
      'opencode.statusWarn': 'API status: {status}',
      'opencode.note': 'OpenCode returns quota percentages and reset times only (rolling 5-hour / weekly / monthly), with no amounts; Zen pay-as-you-go has no official quota API, so amounts are visible only in the OpenCode Console.',
      'opencode.noKey': 'OpenCode not configured',
      'opencode.barTitle': 'No OpenCode key configured',
      'opencode.barSub': 'Reuses the key from the opencode CLI login (~/.local/share/opencode/auth.json) first; you can also paste one manually.',
      'opencode.placeholder': 'Paste an OpenCode API key (sk-…)',
      'opencode.label': 'OpenCode API key',
      'opencode.changeTitle': 'Replace the OpenCode API key',
      'opencode.changeSub': 'A manual key overrides the opencode CLI login key (highest priority, e.g. to replace an expired CLI key); press “Clear manual key” to fall back to the other sources.',
      'opencode.editKey': 'Change key',
      'opencode.clearManual': 'Clear manual key',
      'opencode.clearing': 'Clearing…',
      // v0.9.1: plugin-level "Remove key" (disabled flag; external config is not deleted)
      'opencode.removeKey': 'Remove key',
      'opencode.removing': 'Removing…',
      'opencode.removeKeyHint': 'Disable for this plugin: the DSH credential, environment variable and opencode CLI login key are no longer used; those external settings are not deleted, and “Restore external key” brings them back.',
      'opencode.disabledHint': 'This plugin removed the key: the DSH credential / environment variable / CLI login key are no longer used (external settings are not deleted).',
      'opencode.restoreKey': 'Restore external key',
      'opencode.restoring': 'Restoring…',
      'opencode.restoreHint': 'Restoring uses the DSH credential / environment variable / CLI login key again; you can also paste a new key (saving it restores automatically).',
      'opencode.empty': 'This key has no OpenCode Go subscription',
      'opencode.emptyHint': 'No Go subscription windows were returned for this key (Zen pay-as-you-go has no official quota API); press “Change key” to use a Go-enabled key.',
      'opencode.failed': 'Failed to fetch OpenCode quota',
      'opencode.failedHint': 'The last successfully fetched quota is kept; press Refresh in the header to retry.',
      'opencode.localTitle': 'Local opencode CLI usage',
      'opencode.localHint': 'last {days} days · time zone {tz}',
      'opencode.localToday': 'Today',
      'opencode.localWeek': 'This week',
      'opencode.localMonth': 'This month',
      'opencode.localMeta': '{requests} requests',
      'opencode.localTitleAttr': 'Local opencode.db, last {days} days · time zone {tz} · top models: {models} · not merged with the DSH session-log token stats',
      'opencode.localModelsEmpty': 'no models yet',
      // v0.9.3: local CLI usage cards
      'opencode.localTokenUnit': 'tokens',
      'opencode.localCost': 'Cost',
      'opencode.localRange': '{from} — {to}',
      'opencode.localNote': 'From the local opencode.db · a different basis from the DSH session-log token stats (aggregated by message local hour/day across all OpenCode providers)',
      // v0.9.4: quota-card token estimate
      'opencode.estimateHint': 'Derived from local opencode.db token usage in the matching window divided by the official used percentage: only this machine’s CLI is counted (other clients are excluded) and the estimate is low when history is incomplete; the rolling 5-hour figure approximates with the last 5 local hour buckets. This is an estimate, not the official quota — the percentage and reset time on the card remain official.',
      'opencode.keySource': 'Key source: {source} · {masked}',
      'opencode.winShort.rolling': '5h',
      'opencode.winShort.weekly': 'W',
      'opencode.winShort.monthly': 'M',

      'error.noKey': 'No Ollama API key configured',
      'error.unauthorized': 'Key is invalid or expired (401/403)',
      'error.rateLimit': 'Official API is rate limited; retry shortly',
      'error.network': 'Network request failed',
      'error.http': 'Official API returned an error',
      'error.noData': 'No data available',
      'error.internal': 'Plugin internal error',
      'error.badRequest': 'Malformed request',
      'error.generic': 'Request failed',
      'error.sep': ': ',

      'time.lessThanMinute': 'less than a minute',
      'time.now': 'any moment now',
      'time.days': '{n}d',
      'time.hours': '{n}h',
      'time.minutes': '{n}m',
    }

    /* ══════════════════════════════════════════════════════════════
     * 通用工具（纯函数）
     * ══════════════════════════════════════════════════════════════ */

    const NUMBER_FORMATS = {}

    function numberFormat(kind, lang) {
      const key = kind + ':' + lang
      if (NUMBER_FORMATS[key] !== undefined) return NUMBER_FORMATS[key]
      let options = {}
      if (kind === 'compact') options = { notation: 'compact', maximumFractionDigits: 1 }
      else if (kind === 'pct') options = { maximumFractionDigits: 1 }
      else if (kind === 'usd') options = { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      let format = null
      try {
        format = new Intl.NumberFormat(lang === 'zh' ? 'zh-CN' : 'en-US', options)
      } catch (e) {
        format = null
      }
      NUMBER_FORMATS[key] = format
      return format
    }

    function num(value) {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : 0
    }

    /** 可缺省数值：null / undefined / '' / NaN 一律 null（用于"没有这个数"的语义）。 */
    function maybeNum(value) {
      if (value === null || value === undefined || value === '') return null
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : null
    }

    function clamp(value, lo, hi) {
      if (value < lo) return lo
      if (value > hi) return hi
      return value
    }

    function fmtNum(value, kind, lang) {
      const n = maybeNum(value)
      if (n === null) return '—'
      const format = numberFormat(kind, lang)
      try {
        return format === null ? String(n) : format.format(n)
      } catch (e) {
        return String(n)
      }
    }

    const fmtInt = (value, lang) => fmtNum(value, 'int', lang)
    const fmtCompact = (value, lang) => fmtNum(value, 'compact', lang)
    /**
     * token 数：≥ 100 万用紧凑写法（324.3M / 3.2亿），否则千分位。
     * 调用方把完整千分位放进 title，鼠标悬停即可核对精确值。
     */
    const fmtToken = (value, lang) => {
      const n = maybeNum(value)
      if (n === null) return '—'
      return Math.abs(n) >= 1000000 ? fmtCompact(n, lang) : fmtInt(n, lang)
    }
    const fmtPct = (value, lang) => {
      const n = maybeNum(value)
      return n === null ? '—' : fmtNum(n, 'pct', lang) + '%'
    }
    /**
     * 缓存命中率 = 缓存读 /（输入 + 缓存读）。
     * 注意：DSH 的 usage 里 cacheReadTokens 是**单独计数**、不含在 inputTokens 里
     * （totalTokens = input + output + cacheRead），所以分母必须是「输入 + 缓存读」，
     * 才是「prompt token 中被缓存命中的比例」。结果 clamp 到 0~100；分母为 0 返回 null。
     */
    function cacheHitPercent(bucket) {
      const source = bucket !== null && bucket !== undefined && typeof bucket === 'object' ? bucket : {}
      const input = num(source.input)
      const cacheRead = num(source.cacheRead)
      const prompt = input + cacheRead
      if (!(prompt > 0)) return null
      const pct = (cacheRead / prompt) * 100
      return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10
    }
    const fmtUsd = (value, lang) => {
      const n = maybeNum(value)
      return n === null ? '—' : '$' + fmtNum(n, 'usd', lang)
    }

    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }

    /** 趋势图左轴「整齐」上限：1 / 2 / 2.5 / 5 / 10 × 10^n。 */
    function niceCeil(value) {
      const n = num(value)
      if (!(n > 0)) return 1
      const exponent = Math.pow(10, Math.floor(Math.log10(n)))
      const fraction = n / exponent
      let nice = 10
      if (fraction <= 1) nice = 1
      else if (fraction <= 2) nice = 2
      else if (fraction <= 2.5) nice = 2.5
      else if (fraction <= 5) nice = 5
      return nice * exponent
    }

    /** 本地时区 MM-DD HH:mm（用于 updatedAt / resetsAt 等真实毫秒时间戳）。 */
    function fmtLocal(iso) {
      if (iso === null || iso === undefined || iso === '') return '—'
      const date = new Date(String(iso))
      if (!Number.isFinite(date.getTime())) return String(iso)
      return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    /** 官方 from/until 是纳秒精度 ISO：只按字符串截取，绝不依赖 Date 解析。 */
    function fmtUtcShort(iso) {
      const text = String(iso === null || iso === undefined ? '' : iso)
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text)
      if (match === null) return text === '' ? '—' : text
      return match[2] + '-' + match[3] + ' ' + match[4] + ':' + match[5]
    }

    /** 距重置还有多久；返回本地化片段（如 "1 小时 12 分钟"）。 */
    function countdownText(t, iso) {
      if (iso === null || iso === undefined || iso === '') return null
      const end = Date.parse(String(iso))
      if (!Number.isFinite(end)) return null
      const ms = end - Date.now()
      if (ms <= 0) return t('time.now')
      if (ms < 60000) return t('time.lessThanMinute')
      const totalMinutes = Math.floor(ms / 60000)
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      const parts = []
      if (days > 0) parts.push(t('time.days', { n: days }))
      if (hours > 0 || days > 0) parts.push(t('time.hours', { n: hours }))
      parts.push(t('time.minutes', { n: minutes }))
      return parts.join(' ')
    }

    function toneOf(percent) {
      const n = maybeNum(percent)
      if (n === null) return 'idle'
      if (n >= 90) return 'error'
      if (n >= 70) return 'warn'
      return 'ok'
    }

    function toneColor(percent) {
      const n = maybeNum(percent)
      if (n === null) return 'var(--dsw-alias-label-tertiary)'
      if (n >= 90) return 'var(--dsw-alias-state-error-primary)'
      if (n >= 70) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-success-primary)'
    }

    /**
     * 进度条填充：沿用 toneColor 的语义色（<70% 绿、70–89% 黄、≥90% 红），
     * 用「同色浅→实」的渐变让横条更有层次；快用完时自然变红。
     */
    function toneFill(percent) {
      const color = toneColor(percent)
      return 'linear-gradient(90deg,color-mix(in srgb,' + color + ' 45%,transparent),' + color + ')'
    }

    /** 「N 个会话日志读取失败」提示的忽略状态：记住被忽略时的失败数量（localStorage）。 */
    const IGNORED_FAILED_KEY = 'dsh-ollama-statistical:ignored-failed-count'
    function readIgnoredFailedCount() {
      try {
        const storage = typeof window !== 'undefined' && window !== null ? window.localStorage : null
        if (!storage) return 0
        const raw = storage.getItem(IGNORED_FAILED_KEY)
        const value = raw === null ? null : Number(raw)
        return Number.isFinite(value) && value >= 0 ? value : 0
      } catch (e) {
        return 0
      }
    }
    function writeIgnoredFailedCount(count) {
      try {
        const storage = typeof window !== 'undefined' && window !== null ? window.localStorage : null
        if (!storage) return
        storage.setItem(IGNORED_FAILED_KEY, String(Math.max(0, Math.round(Number(count) || 0))))
      } catch (e) {
        /* 隐私模式 / 存储禁用时忽略即可 */
      }
    }

    /**
     * 周额度 token 估算：官方只给「已用百分比」，本机有 Ollama 的真实 token 消耗。
     * 假设二者成正比：总量 ≈ 已用 token ÷ (已用% / 100)，剩余 = 总量 − 已用。
     * 已用% ≤ 0 或已知 token ≤ 0 时无法推算（返回 null）。
     */
    function estimateQuotaTokens(usedPercent, usedTokens) {
      const pct = maybeNum(usedPercent)
      const used = maybeNum(usedTokens)
      if (pct === null || used === null || pct <= 0 || used <= 0) return null
      const total = used / (pct / 100)
      return {
        used: Math.round(used),
        total: Math.round(total),
        remaining: Math.max(0, Math.round(total - used)),
      }
    }

    function interpolate(text, params) {
      if (params === null || params === undefined) return String(text)
      return String(text).replace(/\{(\w+)\}/g, (whole, name) => {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
      })
    }

    /* ══════════════════════════════════════════════════════════════
     * i18n 服务接线
     * ══════════════════════════════════════════════════════════════ */

    function detectLang(locale) {
      let active = null
      try {
        if (locale !== null && locale !== undefined && typeof locale.getLocale === 'function') {
          const info = locale.getLocale()
          active = typeof info === 'string'
            ? info
            : (info && (info.active || info.locale || info.language))
        }
      } catch (e) {
        active = null
      }
      if (typeof active !== 'string' || active.length === 0) return 'zh'
      return active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    }

    function fallbackDict(locale) {
      return detectLang(locale) === 'zh' ? DICT_ZH : DICT_EN
    }

    /**
     * 注册字典。0.2.x 实际签名是 register(id, { zh, en })（本机 profile 里的
     * dsh-wsl-workspace 实测跑通），契约写的是 register(id, lang, dict)。
     * 按函数 arity 选先试的签名，只有抛错才退回另一种 —— 两者都失败时 t() 自动
     * 退化到内置字典，界面不会空白。
     * 返回清理函数（只有 locale 暴露 unregister 时才会产出，否则 undefined）。
     */
    function registerDictionaries(locale) {
      if (locale === null || locale === undefined || typeof locale.register !== 'function') return undefined
      let arity = 0
      try {
        arity = typeof locale.register.length === 'number' ? locale.register.length : 0
      } catch (e) {
        arity = 0
      }
      const bundled = () => {
        locale.register(BUNDLE_ID, { zh: DICT_ZH, en: DICT_EN })
      }
      const perLanguage = () => {
        locale.register(BUNDLE_ID, 'zh', DICT_ZH)
        locale.register(BUNDLE_ID, 'en', DICT_EN)
      }
      const attempts = arity >= 3 ? [perLanguage, bundled] : [bundled, perLanguage]
      for (let i = 0; i < attempts.length; i += 1) {
        try {
          attempts[i]()
          return makeLocaleDisposer(locale)
        } catch (e) {
          /* try the next registration signature */
        }
      }
      return undefined
    }

    function makeLocaleDisposer(locale) {
      if (locale === null || locale === undefined || typeof locale.unregister !== 'function') return undefined
      return () => {
        try {
          locale.unregister(BUNDLE_ID)
        } catch (e) {
          /* the service may not support unloading this bundle id */
        }
      }
    }

    function createTranslator(locale) {
      let bound = null
      try {
        if (locale !== null && locale !== undefined && typeof locale.bind === 'function') {
          const candidate = locale.bind(BUNDLE_ID)
          if (typeof candidate === 'function') bound = candidate
        }
      } catch (e) {
        bound = null
      }
      return function t(key, params) {
        let text = null
        if (bound !== null) {
          try {
            text = bound(key, params)
          } catch (e) {
            text = null
          }
        }
        // bound() 缺 key 时常把 key 原样返回：这种情况也走内置字典，避免界面出现裸 key。
        if (typeof text !== 'string' || text.length === 0 || text === key) {
          const dict = fallbackDict(locale)
          text = typeof dict[key] === 'string' ? dict[key] : key
        }
        return interpolate(text, params)
      }
    }

    const ERROR_KEYS = {
      'no-key': 'error.noKey',
      unauthorized: 'error.unauthorized',
      'rate-limit': 'error.rateLimit',
      network: 'error.network',
      http: 'error.http',
      'no-data': 'error.noData',
      internal: 'error.internal',
      'bad-request': 'error.badRequest',
    }

    function errText(err, t) {
      if (err === null || err === undefined || typeof err !== 'object') return t('error.generic')
      const key = ERROR_KEYS[err.code]
      const base = key ? t(key) : t('error.generic')
      const detail = err.message ? String(err.message) : ''
      if (detail === '') return key ? base : base + ' (' + String(err.code) + ')'
      return base + t('error.sep') + detail
    }

    /* ══════════════════════════════════════════════════════════════
     * 图标（原创 SVG，全部 currentColor）
     * ══════════════════════════════════════════════════════════════ */

    function iconBase(size, children) {
      return h('svg', {
        className: 'osta-section-icon',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      }, children)
    }

    function IconLimits() {
      return iconBase(14, [
        h('path', { key: 'a', d: 'M2.2 12.4a5.9 5.9 0 0 1 11.6 0', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M8 12.2 10.4 9.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { key: 'c', cx: 8, cy: 12.2, r: 1, fill: 'currentColor' }),
      ])
    }

    function IconTokens() {
      return iconBase(14, [
        h('path', { key: 'a', d: 'M2.4 13.4h11.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', opacity: 0.5 }),
        h('path', { key: 'b', d: 'M4.6 13.2V9.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { key: 'c', d: 'M8 13.2V6.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { key: 'd', d: 'M11.4 13.2V4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      ])
    }

    function IconOfficial() {
      return iconBase(14, [
        h('path', {
          key: 'a',
          d: 'M4.6 12.2h6.7a2.6 2.6 0 0 0 .3-5.18A3.5 3.5 0 0 0 5.4 5.7a2.5 2.5 0 0 0-.8 6.5z',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinejoin: 'round',
        }),
        h('path', { key: 'b', d: 'M8 8.6v2.2', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' }),
      ])
    }

    function IconRefresh() {
      return h('svg', {
        width: 13,
        height: 13,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      }, [
        h('path', { key: 'a', d: 'M13 8a5 5 0 1 1-1.7-3.8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M13 2.8V5.7h-2.9', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ])
    }

    function IconKey() {
      return h('svg', {
        width: 15,
        height: 15,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
        className: 'osta-keybar-icon',
      }, [
        h('circle', { key: 'a', cx: 5.6, cy: 5.6, r: 2.7, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { key: 'b', d: 'M7.7 7.7 13.2 13.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { key: 'c', d: 'M10.6 10.6l1.7-1.7', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      ])
    }

    function IconAlert() {
      return h('svg', {
        width: 13,
        height: 13,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        className: 'osta-errorbar-icon',
      }, [
        h('path', { key: 'a', d: 'M8 2.4 14.2 13H1.8z', stroke: 'currentColor', strokeWidth: 1.35, strokeLinejoin: 'round' }),
        h('path', { key: 'b', d: 'M8 6.2v3', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' }),
        h('circle', { key: 'c', cx: 8, cy: 11, r: 0.8, fill: 'currentColor' }),
      ])
    }

    function PanelIcon(props) {
      const raw = props && typeof props.size === 'number' && Number.isFinite(props.size) ? props.size : 20
      const size = clamp(raw, 14, 24)
      const active = props && props.active === true
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      }, [
        h('path', { key: 'base', d: 'M4.2 20.2h15.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', opacity: 0.45 }),
        h('path', { key: 'b1', d: 'M7.4 20V14.4', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', { key: 'b2', d: 'M12 20V9.8', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', { key: 'b3', d: 'M16.6 20V6.2', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('circle', { key: 'dot', cx: 16.6, cy: 3.1, r: 1.5, fill: 'currentColor' }),
      ])
    }

    /* ══════════════════════════════════════════════════════════════
     * 视图数据推导（纯函数，全部来自契约 value）
     * ══════════════════════════════════════════════════════════════ */

    function dayList(tokens) {
      if (tokens === null || tokens === undefined || !Array.isArray(tokens.days)) return []
      return tokens.days.filter((day) => day !== null && typeof day === 'object' && typeof day.date === 'string')
    }

    function boundsOf(tokens) {
      const days = dayList(tokens)
      const today = tokens && typeof tokens.today === 'string'
        ? tokens.today
        : (days.length > 0 ? days[days.length - 1].date : '')
      const first = days.length > 0 ? days[0].date : today
      const weekStart = tokens && typeof tokens.weekStart === 'string' ? tokens.weekStart : today
      return { days, today, first, weekStart }
    }

    /** 契约 tokens.providers[] 里的合法供应商项（按宿主给的 total 降序）。 */
    function tokenProviders(tokens) {
      if (tokens === null || tokens === undefined || !Array.isArray(tokens.providers)) return []
      return tokens.providers.filter((entry) => entry !== null && typeof entry === 'object'
        && typeof entry.provider === 'string' && entry.provider !== '')
    }

    const EMPTY_DAY_BUCKET = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, requests: 0, sessions: 0 }

    /** 日桶归一化：契约里 providers[].days 是完整桶，缺失字段按 0 处理。 */
    function normalizeDayBucket(day) {
      return {
        date: String(day.date),
        input: num(day.input),
        output: num(day.output),
        cacheRead: num(day.cacheRead),
        cacheWrite: num(day.cacheWrite),
        reasoning: num(day.reasoning),
        total: num(day.total),
        requests: num(day.requests),
        sessions: num(day.sessions),
      }
    }

    /**
     * 单供应商的日桶：契约说 providers[].days 与 tokens.days 同长同序（完整桶），
     * 这里按日期对齐（缺日期补 0、多日期忽略），保留 input/output/缓存/会话等全部字段。
     * 返回 [] 表示该供应商没有逐日明细，调用方走窗口 totals 降级。
     */
    function providerDaysOf(provider, bounds) {
      if (provider === null || provider === undefined) return []
      const raw = Array.isArray(provider.days)
        ? provider.days.filter((day) => day !== null && typeof day === 'object' && typeof day.date === 'string')
        : []
      if (raw.length === 0) return []
      if (bounds.days.length === 0) return raw.map(normalizeDayBucket)
      const byDate = new Map()
      raw.forEach((day) => { byDate.set(day.date, day) })
      return bounds.days.map((day) => {
        const entry = byDate.get(day.date)
        return entry === undefined
          ? Object.assign({ date: day.date }, EMPTY_DAY_BUCKET)
          : normalizeDayBucket(entry)
      })
    }

    /**
     * 按供应商选数据源：'all' → tokens.days + tokens.models；
     * 其它 → providers[].days（完整桶）+ providers[].models。
     * totals 只在该供应商缺 days 明细时作为降级兜底。
     * 供应商不存在时安全退回 'all'（isAll=true）。
     */
    function selectTokenSource(tokens, providerId) {
      const providers = tokenProviders(tokens)
      const wanted = typeof providerId === 'string' && providerId !== '' ? providerId : 'all'
      let provider = null
      if (wanted !== 'all') {
        for (let i = 0; i < providers.length; i += 1) {
          if (providers[i].provider === wanted) {
            provider = providers[i]
            break
          }
        }
      }
      const bounds = boundsOf(tokens)
      const isAll = provider === null
      const models = isAll
        ? (tokens !== null && tokens !== undefined && Array.isArray(tokens.models) ? tokens.models : [])
        : (Array.isArray(provider.models) ? provider.models : [])
      const totals = isAll ? null : {
        input: num(provider.input),
        output: num(provider.output),
        cacheRead: num(provider.cacheRead),
        cacheWrite: num(provider.cacheWrite),
        reasoning: num(provider.reasoning),
        total: num(provider.total),
        requests: num(provider.requests),
        sessions: num(provider.sessions),
      }
      return {
        providerId: isAll ? 'all' : provider.provider,
        isAll,
        provider,
        days: isAll ? bounds.days : providerDaysOf(provider, bounds),
        models,
        totals,
        today: bounds.today,
        weekStart: bounds.weekStart,
        first: bounds.first,
      }
    }

    /**
     * 在所选数据源的日桶上按 tab 切片求和（全部供应商与单供应商同口径）。
     * - 各字段都来自 days 切片求和（契约已给完整桶）；
     * - activeDays = 范围内 total>0 或 requests>0 的天数；
     * - 供应商没有 days 明细时 degraded=true，退回窗口 totals（图表隐藏）。
     */
    function computeSourceRange(source, tab, customFrom, customTo) {
      const days = Array.isArray(source.days) ? source.days : []
      const today = source.today || ''
      const first = source.first || (days.length > 0 ? days[0].date : today)
      const weekStart = source.weekStart || today

      if (days.length === 0 && source.totals !== null) {
        const totals = source.totals
        return {
          lo: '',
          hi: '',
          days: [],
          degraded: true,
          agg: {
            input: num(totals.input),
            output: num(totals.output),
            cacheRead: num(totals.cacheRead),
            cacheWrite: num(totals.cacheWrite),
            reasoning: num(totals.reasoning),
            total: num(totals.total),
            requests: num(totals.requests),
            sessions: num(totals.sessions),
            activeDays: 0,
          },
          bounds: { days: [], today, first, weekStart },
        }
      }

      let lo
      let hi
      if (tab === 'today') {
        lo = today
        hi = today
      } else if (tab === 'week') {
        lo = weekStart
        hi = today
        if (lo > hi) lo = hi
      } else {
        lo = customFrom || first
        hi = customTo || today
        if (lo > hi) {
          const swapped = lo
          lo = hi
          hi = swapped
        }
        if (lo < first) lo = first
        if (hi > today) hi = today
        if (lo > hi) {
          lo = first
          hi = today
        }
      }
      const selected = days.filter((day) => day.date >= lo && day.date <= hi)
      const agg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, requests: 0, sessions: 0, activeDays: 0 }
      selected.forEach((day) => {
        agg.input += num(day.input)
        agg.output += num(day.output)
        agg.cacheRead += num(day.cacheRead)
        agg.cacheWrite += num(day.cacheWrite)
        agg.reasoning += num(day.reasoning)
        agg.total += num(day.total)
        agg.requests += num(day.requests)
        agg.sessions += num(day.sessions)
        if (num(day.total) > 0 || num(day.requests) > 0) agg.activeDays += 1
      })
      return { lo, hi, days: selected, degraded: false, agg, bounds: { days, today, first, weekStart } }
    }

    /** 兼容旧签名：全部供应商视图 = selectTokenSource(tokens,'all') 上的切片。 */
    function computeRange(tokens, tab, customFrom, customTo) {
      return computeSourceRange(selectTokenSource(tokens, 'all'), tab, customFrom, customTo)
    }

    /** 「按供应商分布」行：provider + 窗口内 total/requests + 占比（按 total 降序）。 */
    function buildProviderRows(tokens) {
      const providers = tokenProviders(tokens)
      let sum = 0
      providers.forEach((provider) => { sum += num(provider.total) })
      return providers
        .map((provider) => ({
          provider: provider.provider,
          total: num(provider.total),
          requests: num(provider.requests),
          sessions: num(provider.sessions),
          share: sum > 0 ? (num(provider.total) / sum) * 100 : 0,
        }))
        .sort((left, right) => right.total - left.total)
    }

    /** 单个供应商在 [lo,hi] 范围内的日桶合计；providers[].days 缺失时返回 null（口径不可知）。 */
    function providerRangeTotal(provider, lo, hi) {
      if (provider === null || provider === undefined) return null
      const raw = Array.isArray(provider.days) ? provider.days : []
      if (raw.length === 0) return null
      const from = typeof lo === 'string' ? lo : ''
      const to = typeof hi === 'string' ? hi : ''
      let total = 0
      let requests = 0
      let counted = false
      for (let i = 0; i < raw.length; i += 1) {
        const day = raw[i]
        if (day === null || typeof day !== 'object' || typeof day.date !== 'string') continue
        if (day.date < from || day.date > to) continue
        total += num(day.total)
        requests += num(day.requests)
        counted = true
      }
      return counted ? { total, requests } : { total: 0, requests: 0 }
    }

    /**
     * 「按供应商分布」与筛选 chips 的范围口径行：在 [lo,hi] 内按 providers[].days 求和。
     * - 顺序固定按窗口总量降序（不随所选范围抖动）；
     * - 占比分母 = 同一范围内 tokens.days 的合计（= 全部视图 hero 的总 token），保证一致；
     * - providers[].days 缺失时 total/requests/share 为 null（UI 显示「—」）。
     */
    function providerRangeRows(tokens, lo, hi) {
      const providers = tokenProviders(tokens)
      const from = typeof lo === 'string' ? lo : ''
      const to = typeof hi === 'string' ? hi : ''
      let allTotal = 0
      dayList(tokens).forEach((day) => {
        if (day.date < from || day.date > to) return
        allTotal += num(day.total)
      })
      const windowOrder = new Map()
      providers.forEach((provider, index) => { windowOrder.set(provider.provider, index) })
      return providers
        .map((provider) => {
          const range = providerRangeTotal(provider, from, to)
          const total = range === null ? null : range.total
          const requests = range === null ? null : range.requests
          return {
            provider: provider.provider,
            total,
            requests,
            share: total !== null && allTotal > 0 ? (total / allTotal) * 100 : null,
            windowTotal: num(provider.total),
            degraded: range === null,
          }
        })
        .sort((left, right) => {
          // 列表展示的是「当前范围」数字，因此排序也按范围值从高到低（degraded/null 排最后）；
          // 范围值相同时退回窗口总量、宿主顺序，保证稳定。
          const leftTotal = left.total === null ? -1 : left.total
          const rightTotal = right.total === null ? -1 : right.total
          if (rightTotal !== leftTotal) return rightTotal - leftTotal
          if (right.windowTotal !== left.windowTotal) return right.windowTotal - left.windowTotal
          return (windowOrder.get(left.provider) || 0) - (windowOrder.get(right.provider) || 0)
        })
    }

    /**
     * 模型榜的范围口径行：在 [lo,hi] 内按 models[].days（{date,total,requests}）求和。
     * - providerId==='all' → tokens.models；否则 → providers[].models；
     * - share 分母 = 当前视图范围总 token（all → tokens.days 范围合计；
     *   单供应商 → providers[].days 范围合计；缺 days 时退回该供应商窗口 total）；
     * - models[].days 缺失 → 用窗口 total/requests 兜底并标 degraded=true（UI 显示「窗口值」）；
     * - 排序固定按窗口 total 降序（不随范围抖动）。
     */
    function modelRangeRows(tokens, providerId, lo, hi) {
      const providers = tokenProviders(tokens)
      const wanted = typeof providerId === 'string' && providerId !== '' ? providerId : 'all'
      let provider = null
      if (wanted !== 'all') {
        for (let i = 0; i < providers.length; i += 1) {
          if (providers[i].provider === wanted) {
            provider = providers[i]
            break
          }
        }
      }
      const isAll = provider === null
      const sourceModels = isAll
        ? (tokens !== null && tokens !== undefined && Array.isArray(tokens.models) ? tokens.models : [])
        : (Array.isArray(provider.models) ? provider.models : [])
      const from = typeof lo === 'string' ? lo : ''
      const to = typeof hi === 'string' ? hi : ''
      let rangeTotal = 0
      if (isAll) {
        dayList(tokens).forEach((day) => {
          if (day.date < from || day.date > to) return
          rangeTotal += num(day.total)
        })
      } else {
        const providerRange = providerRangeTotal(provider, from, to)
        rangeTotal = providerRange === null ? num(provider.total) : providerRange.total
      }
      const rows = sourceModels
        .filter((model) => model !== null && typeof model === 'object' && typeof model.model === 'string')
        .map((model, index) => {
          const rawDays = Array.isArray(model.days) ? model.days : []
          const hasDays = rawDays.length > 0
          let total = num(model.total)
          let requests = num(model.requests)
          if (hasDays) {
            total = 0
            requests = 0
            for (let i = 0; i < rawDays.length; i += 1) {
              const day = rawDays[i]
              if (day === null || typeof day !== 'object' || typeof day.date !== 'string') continue
              if (day.date < from || day.date > to) continue
              total += num(day.total)
              requests += num(day.requests)
            }
          }
          return {
            provider: typeof model.provider === 'string' && model.provider !== '' ? model.provider : null,
            model: model.model,
            total,
            requests,
            share: hasDays ? (rangeTotal > 0 ? (total / rangeTotal) * 100 : 0) : null,
            degraded: !hasDays,
            windowTotal: num(model.total),
            windowRequests: num(model.requests),
            order: index,
          }
        })
      rows.sort((left, right) => {
        // 模型榜按「当前范围」token 从高到低排序（展示什么就按什么排），
        // 同值退回窗口总量、宿主顺序。
        const leftTotal = left.total === null ? -1 : left.total
        const rightTotal = right.total === null ? -1 : right.total
        if (rightTotal !== leftTotal) return rightTotal - leftTotal
        if (right.windowTotal !== left.windowTotal) return right.windowTotal - left.windowTotal
        return left.order - right.order
      })
      rows.forEach((row) => { delete row.order })
      return rows
    }

    /**
     * 可选指标是否展示：这些字段不是所有供应商都会上报
     * （OpenAI 兼容接口只给 prompt/completion/cached tokens，没有 cache write / reasoning tokens）。
     * 当前视图下为 0 就视为「没有」，直接不渲染对应卡片，避免一排 0 干扰阅读。
     */
    function showOptionalMetric(agg, field) {
      const source = agg !== null && agg !== undefined && typeof agg === 'object' ? agg : {}
      if (field === 'cacheHit') return num(source.cacheRead) > 0
      if (field === 'cacheWrite') return num(source.cacheWrite) > 0
      if (field === 'reasoning') return num(source.reasoning) > 0
      return true
    }
    /** 小时桶校验：必须恰好 24 项；hour 标签缺失/非法时按索引补 00..23。完整桶（缺字段按 0）。 */
    function normalizeHourBuckets(list) {
      if (!Array.isArray(list) || list.length !== 24) return null
      const hours = []
      for (let i = 0; i < 24; i += 1) {
        const entry = list[i]
        if (entry === null || typeof entry !== 'object') return null
        const label = typeof entry.hour === 'string' && /^\d{2}$/.test(entry.hour) ? entry.hour : pad2(i)
        const input = num(entry.input)
        const output = num(entry.output)
        const totalMissing = entry.total === null || entry.total === undefined
        hours.push({
          label,
          input,
          output,
          cacheRead: num(entry.cacheRead),
          cacheWrite: num(entry.cacheWrite),
          reasoning: num(entry.reasoning),
          // 旧缓存可能没有 total：退回 input+output，保证点里一定有 total。
          total: totalMissing ? input + output : num(entry.total),
          requests: num(entry.requests),
          sessions: num(entry.sessions),
        })
      }
      return hours
    }

    /**
     * 多序列趋势图数据（粒度随范围自适应）：
     * - 「今天」、或自定义范围起止都等于今天 → `mode:'hour'`，数据取
     *   tokens.hours / providers[].hours（24 项完整桶）；
     * - 其它 → `mode:'day'`，沿用 days 按 [lo,hi] 切片（完整桶）；
     * - 小时桶缺失 / 长度不为 24 → 自动回退天模式（今天即 1 个点），不报错；
     * - 供应商没有 days 明细 → `degraded:true`（调用方隐藏图表）。
     * points: [{label, hint, input, output, cacheRead, cacheWrite, reasoning, total,
     *           requests, sessions, hitRate}]，hitRate 分母为 0 时为 null。
     */
    function chartTrend(tokens, providerId, tab, customFrom, customTo) {
      const providers = tokenProviders(tokens)
      const wanted = typeof providerId === 'string' && providerId !== '' ? providerId : 'all'
      let provider = null
      if (wanted !== 'all') {
        for (let i = 0; i < providers.length; i += 1) {
          if (providers[i].provider === wanted) {
            provider = providers[i]
            break
          }
        }
      }
      const isAll = provider === null
      const bounds = boundsOf(tokens)
      const today = bounds.today
      const from = typeof customFrom === 'string' ? customFrom : ''
      const to = typeof customTo === 'string' ? customTo : ''
      const toPoint = (bucket, label, hint) => ({
        label,
        hint,
        input: num(bucket.input),
        output: num(bucket.output),
        cacheRead: num(bucket.cacheRead),
        cacheWrite: num(bucket.cacheWrite),
        reasoning: num(bucket.reasoning),
        total: num(bucket.total),
        requests: num(bucket.requests),
        sessions: num(bucket.sessions),
        hitRate: cacheHitPercent(bucket),
      })
      const wantsHourly = tab === 'today' || (tab === 'custom' && today !== '' && from === today && to === today)
      if (wantsHourly) {
        const hours = isAll
          ? normalizeHourBuckets(tokens !== null && tokens !== undefined ? tokens.hours : null)
          : normalizeHourBuckets(provider.hours)
        if (hours !== null) {
          return {
            mode: 'hour',
            lo: today,
            hi: today,
            points: hours.map((hour) => toPoint(hour, hour.label, hour.label + ':00–' + hour.label + ':59')),
          }
        }
      }
      const source = selectTokenSource(tokens, isAll ? 'all' : provider.provider)
      const view = computeSourceRange(source, tab, customFrom, customTo)
      return {
        mode: 'day',
        degraded: view.degraded === true,
        lo: view.lo,
        hi: view.hi,
        points: view.days.map((day) => toPoint(day, day.date, day.date)),
      }
    }

    /**
     * 兼容旧测试/旧调用：只保留柱状图口径需要的字段（mode/points/total/requests）。
     */
    function chartSeries(tokens, providerId, tab, customFrom, customTo) {
      const trend = chartTrend(tokens, providerId, tab, customFrom, customTo)
      return {
        mode: trend.mode,
        degraded: trend.degraded,
        lo: trend.lo,
        hi: trend.hi,
        points: trend.points.map((point) => ({
          label: point.label,
          hint: point.hint,
          total: point.total,
          requests: point.requests,
          sessions: point.sessions,
        })),
      }
    }


    /* ══════════════════════════════════════════════════════════════
     * OpenCode Go（v0.8 增量）：额度窗口 / 侧栏汇总行 / 本机 CLI 用量
     *
     * 数据来自 snapshot.opencode（契约 §7.3）。旧 host 没有该字段，
     * 因此所有入口都必须容忍 null / 字段缺失：返回 null 或全 null 的行，
     * 绝不抛错、不伪造 error。纯函数，不依赖 React / t（i18n 由调用方取 key）。
     * ══════════════════════════════════════════════════════════════ */

    /** 三个额度窗口的固定顺序与 i18n key（Go 的 rolling 5h / weekly / monthly）。 */
    const OPENCODE_WINDOWS = [
      { key: 'rolling', titleKey: 'opencode.rolling', subKey: 'opencode.rollingSub', shortKey: 'opencode.winShort.rolling' },
      { key: 'weekly', titleKey: 'opencode.weekly', subKey: 'opencode.weeklySub', shortKey: 'opencode.winShort.weekly' },
      { key: 'monthly', titleKey: 'opencode.monthly', subKey: 'opencode.monthlySub', shortKey: 'opencode.winShort.monthly' },
    ]

    /**
     * 归一化 snapshot.opencode：旧 host 缺字段 / null → 视为未配置（不报错）。
     * key.source 才是「是否配置」的权威判定（契约 §7.3）。
     */
    function opencodeState(opencode) {
      const hasSource = opencode !== null && opencode !== undefined && typeof opencode === 'object'
      const key = hasSource && opencode.key !== null && opencode.key !== undefined && typeof opencode.key === 'object'
        ? opencode.key
        : { source: 'none', masked: null }
      const keySource = typeof key.source === 'string' && key.source !== '' ? key.source : 'none'
      const configured = keySource !== 'none' || (hasSource && opencode.configured === true)
      const kind = hasSource && typeof opencode.kind === 'string' && opencode.kind !== '' ? opencode.kind : 'none'
      return {
        present: hasSource,
        configured,
        key: { source: keySource, masked: typeof key.masked === 'string' ? key.masked : null },
        kind,
        usage: hasSource && opencode.usage !== null && opencode.usage !== undefined && typeof opencode.usage === 'object' ? opencode.usage : null,
        local: hasSource && opencode.local !== null && opencode.local !== undefined && typeof opencode.local === 'object' ? opencode.local : null,
        note: hasSource && typeof opencode.note === 'string' && opencode.note !== '' ? opencode.note : null,
        fetchedAt: hasSource && typeof opencode.fetchedAt === 'string' && opencode.fetchedAt !== '' ? opencode.fetchedAt : null,
        // v0.9.1：插件级停用标志（用户在页面上「移除 Key」）。true 时 host 不再解析/使用任何 OpenCode Key。
        disabled: hasSource && opencode.disabled === true,
      }
    }

    /**
     * 三个额度窗口 → 渲染行（顺序固定 rolling/weekly/monthly）。
     * usedPercent 缺省为 null（窗口不存在 / 字段缺失），否则 round2(clamp(0,100))；
     * remainingPercent 缺失时由 100 - used 反推。UI 用 titleKey/subKey 取译文。
     */
    function opencodeWindowRows(opencode) {
      const state = opencodeState(opencode)
      return OPENCODE_WINDOWS.map((win) => {
        const raw = state.usage === null ? null : state.usage[win.key]
        const entry = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : null
        const usedRaw = entry === null ? null : maybeNum(entry.usedPercent)
        const used = usedRaw === null ? null : Math.round(clamp(usedRaw, 0, 100) * 100) / 100
        const remainingRaw = entry === null ? null : maybeNum(entry.remainingPercent)
        const remaining = remainingRaw !== null
          ? Math.round(clamp(remainingRaw, 0, 100) * 100) / 100
          : (used === null ? null : Math.round((100 - used) * 100) / 100)
        const status = entry !== null && typeof entry.status === 'string' && entry.status !== '' ? entry.status : null
        return {
          key: win.key,
          titleKey: win.titleKey,
          subKey: win.subKey,
          shortKey: win.shortKey,
          present: entry !== null,
          usedPercent: used,
          remainingPercent: remaining,
          resetsAt: entry !== null && typeof entry.resetsAt === 'string' && entry.resetsAt !== '' ? entry.resetsAt : null,
          status,
          tone: toneOf(used),
        }
      })
    }

    /**
     * 侧栏汇总行：仅当有 OpenCode Go 数据（kind === 'go' 且至少一个窗口有百分比）时返回，
     * percent 取三窗口 usedPercent 最大者，windows 供 title 列出三个窗口的明细。
     * 无 Go 数据（未配置 / kind=none / usage=null）→ null（侧栏不出现该行）。
     */
    function opencodeBarsRow(opencode) {
      const state = opencodeState(opencode)
      if (state.kind !== 'go') return null
      const rows = opencodeWindowRows(opencode)
      const windows = []
      let max = null
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]
        windows.push({
          key: row.key,
          shortKey: row.shortKey,
          usedPercent: row.usedPercent,
          resetsAt: row.resetsAt,
        })
        if (row.usedPercent === null) continue
        if (max === null || row.usedPercent > max.usedPercent) max = row
      }
      if (max === null) return null
      return {
        key: 'opencode',
        windowKey: max.key,
        percent: max.usedPercent,
        resetsAt: max.resetsAt,
        windows,
      }
    }

    /**
     * 本机 opencode CLI 用量（snapshot.opencode.local）→ 今天/本周/本月三列 + top3 模型。
     * local 不可用（null / available:false / 没有 totals）→ null（不渲染，避免噪音）。
     */
    function opencodeLocalSummary(local) {
      if (local === null || local === undefined || typeof local !== 'object') return null
      if (local.available === false) return null
      const totals = local.totals !== null && local.totals !== undefined && typeof local.totals === 'object' ? local.totals : null
      if (totals === null) return null
      const pick = (period) => {
        const bucket = totals[period] !== null && totals[period] !== undefined && typeof totals[period] === 'object' ? totals[period] : null
        if (bucket === null) return null
        const total = maybeNum(bucket.total)
        const requests = maybeNum(bucket.requests)
        const costUsd = maybeNum(bucket.costUsd)
        const input = maybeNum(bucket.input)
        const output = maybeNum(bucket.output)
        const cacheRead = maybeNum(bucket.cacheRead)
        if (total === null && requests === null && costUsd === null && input === null && output === null && cacheRead === null) return null
        return {
          period,
          total: total === null ? 0 : total,
          requests: requests === null ? 0 : requests,
          costUsd: costUsd === null ? 0 : costUsd,
          input: input === null ? 0 : input,
          output: output === null ? 0 : output,
          cacheRead: cacheRead === null ? 0 : cacheRead,
        }
      }
      const today = pick('today')
      const week = pick('week')
      const month = pick('month')
      if (today === null && week === null && month === null) return null
      const rawModels = Array.isArray(local.models) ? local.models : []
      const models = rawModels
        .filter((entry) => entry !== null && entry !== undefined && typeof entry === 'object')
        .map((entry) => ({
          provider: typeof entry.provider === 'string' ? entry.provider : '',
          model: typeof entry.model === 'string' ? entry.model : '',
          total: num(entry.total),
        }))
        .filter((entry) => entry.model !== '')
        .sort((a, b) => b.total - a.total)
        .slice(0, 3)
      // v0.9.3：今天的 24 小时桶（旧 host 可能没有 → []，卡片回退为单个日桶）与 30 天日桶。
      const rawHours = Array.isArray(local.hours) ? local.hours : []
      const hours = rawHours
        .filter((entry) => entry !== null && entry !== undefined && typeof entry === 'object')
        .map((entry) => ({
          hour: typeof entry.hour === 'string' && entry.hour !== '' ? entry.hour : '',
          total: num(entry.total),
          requests: num(entry.requests),
        }))
      const rawDays = Array.isArray(local.days) ? local.days : []
      const days = rawDays
        .filter((entry) => entry !== null && entry !== undefined && typeof entry === 'object' && typeof entry.date === 'string')
        .map((entry) => ({
          date: entry.date,
          total: num(entry.total),
          requests: num(entry.requests),
        }))
      const windowDays = maybeNum(local.windowDays)
      const readDate = (value) => (typeof value === 'string' && value !== '' ? value : null)
      return {
        today,
        week,
        month,
        models,
        hours,
        days,
        todayDate: readDate(local.today),
        weekStart: readDate(local.weekStart),
        monthStart: readDate(local.monthStart),
        timeZone: typeof local.timeZone === 'string' && local.timeZone !== '' ? local.timeZone : null,
        windowDays: windowDays === null ? 30 : windowDays,
        generatedAt: typeof local.generatedAt === 'string' && local.generatedAt !== '' ? local.generatedAt : null,
      }
    }

    /** 用 ISO 时间 + IANA 时区取「本地小时」（0-23）；解析失败 / 时区非法 → null。 */
    function localHourOf(iso, timeZone) {
      if (typeof iso !== 'string' || iso === '') return null
      const timestamp = Date.parse(iso)
      if (!Number.isFinite(timestamp)) return null
      try {
        const options = { hour: '2-digit', hourCycle: 'h23' }
        if (typeof timeZone === 'string' && timeZone !== '') options.timeZone = timeZone
        const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(new Date(timestamp))
        for (let i = 0; i < parts.length; i += 1) {
          if (parts[i].type === 'hour') {
            const hour = Number(parts[i].value)
            if (!Number.isFinite(hour)) return null
            return hour === 24 ? 0 : hour
          }
        }
        return null
      } catch (e) {
        return null
      }
    }

    /**
     * v0.9.4：OpenCode 额度卡的 token 估算（复用 Ollama 周卡的「本机用量 ÷ 官方已用百分比」思路）。
     * 返回三个窗口的 usedTokens（本机口径已用 token）：{ rolling, weekly, monthly }。
     *  - rolling：用 local.generatedAt + timeZone 取当前本地小时，汇总 local.hours 最近 5 个小时桶
     *    （current-4 .. current）；当前小时 < 4（跨日窗口不完整）→ null；
     *  - weekly / monthly：直接用 totals.week.total / totals.month.total；
     *  - local 不可用 / 该窗口没有数据 → null（卡片只是不显示估算，不影响官方百分比卡）。
     * 纯函数，不依赖 React。
     */
    function opencodeQuotaEstimates(local) {
      const summary = opencodeLocalSummary(local)
      if (summary === null) return { rolling: null, weekly: null, monthly: null }
      const weekly = summary.week !== null ? summary.week.total : null
      const monthly = summary.month !== null ? summary.month.total : null
      let rolling = null
      const currentHour = localHourOf(summary.generatedAt, summary.timeZone)
      if (currentHour !== null && currentHour >= 4 && summary.hours.length > 0) {
        const byHour = new Map()
        summary.hours.forEach((bucket) => {
          if (bucket.hour !== '') byHour.set(bucket.hour, bucket)
        })
        let sum = 0
        let found = 0
        for (let offset = 4; offset >= 0; offset -= 1) {
          const bucket = byHour.get(pad2(currentHour - offset))
          if (bucket === undefined) continue
          found += 1
          sum += bucket.total
        }
        // 最近 5 个小时桶一个都没有 → 视为没有可用数据（旧 host 无 hours 时也是这样）。
        rolling = found > 0 ? sum : null
      }
      return { rolling, weekly, monthly }
    }

    /**
     * v0.9：Key 是否已配置（Ollama / OpenCode 都不是必填）。
     * 只看 snapshot 里的 key.source（'none' 视为未配置）；旧 host 缺 opencode 字段 → false。
     * 返回值供「A 区显隐 / 官方用量显隐 / 侧栏行 / 配置入口」统一使用。
     */
    function providerKeyFlags(snap) {
      const source = snap !== null && snap !== undefined && typeof snap === 'object' ? snap : {}
      const key = source.key !== null && source.key !== undefined && typeof source.key === 'object' ? source.key : null
      const hasOllamaKey = key !== null && typeof key.source === 'string' && key.source !== 'none'
      const opencode = source.opencode !== null && source.opencode !== undefined && typeof source.opencode === 'object'
        ? source.opencode
        : null
      const opencodeKey = opencode !== null && opencode.key !== null && opencode.key !== undefined && typeof opencode.key === 'object'
        ? opencode.key
        : null
      const hasOpenCodeKey = opencodeKey !== null && typeof opencodeKey.source === 'string' && opencodeKey.source !== 'none'
      // v0.9.1：插件级移除标志（仅用于 KeyPanel 的「恢复外部 Key」提示；不改变 hasOpenCodeKey 的判定）。
      const opencodeDisabled = opencode !== null && opencode.disabled === true
      return {
        hasOllamaKey,
        hasOpenCodeKey,
        opencodeDisabled,
        anyKey: hasOllamaKey || hasOpenCodeKey,
        missingOllama: !hasOllamaKey,
        missingOpenCode: !hasOpenCodeKey,
        // 页头「配置 Key」按钮：至少一个 provider 未配置时显示。
        showConfig: !(hasOllamaKey && hasOpenCodeKey),
      }
    }

    /**
     * v0.9.2：provider 显示开关。snap.visibility 缺字段 / 非对象 / 非布尔值一律视为「显示」，
     * 只有显式 false 才隐藏（旧 host 没有该字段 → 两个都开）。
     */
    function providerVisibility(snap) {
      const source = snap !== null && snap !== undefined && typeof snap === 'object' ? snap : {}
      const raw = source.visibility !== null && source.visibility !== undefined && typeof source.visibility === 'object'
        ? source.visibility
        : null
      const read = (key) => (raw === null ? true : raw[key] !== false)
      return { ollama: read('ollama'), opencode: read('opencode') }
    }

    // v0.9.2：页头开关与侧栏横条是两个独立组件，用模块内订阅让侧栏即时跟随，
    // 不必等 UsageBars 自己的 60s snapshot 轮询。
    const visibilityListeners = new Set()
    function publishVisibility(value) {
      const normalized = providerVisibility({ visibility: value })
      for (const listener of Array.from(visibilityListeners)) {
        try {
          listener(normalized)
        } catch (e) {
          /* 单个订阅者异常不影响其它订阅者 */
        }
      }
    }

    function sourceLabel(source, t) {
      if (!source) return t('source.none')
      const key = 'source.' + String(source)
      if (typeof DICT_ZH[key] === 'string' || typeof DICT_EN[key] === 'string') return t(key)
      return String(source)
    }

    /* ══════════════════════════════════════════════════════════════
     * 插件主体
     * ══════════════════════════════════════════════════════════════ */

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined || slots === null) return

      const connection = ctx.get('connection')

      let locale = null
      try {
        locale = ctx.get('locale')
      } catch (e) {
        locale = null
      }

      /**
       * 样式与 locale 字典都是插件资源：在 ctx.effect 里注册，卸载时移除。
       * ctx.effect 不可用（老宿主 / 测试 fake ctx）时退化为直接注册，界面不受影响。
       */
      const registerClientResources = () => {
        const styleTag = injectCss()
        const disposeDictionary = registerDictionaries(locale)
        return () => {
          if (styleTag !== null && styleTag !== undefined) {
            try {
              if (styleTag.parentNode) styleTag.parentNode.removeChild(styleTag)
              else if (typeof styleTag.remove === 'function') styleTag.remove()
            } catch (e) {
              /* the style tag may already be detached */
            }
          }
          if (typeof disposeDictionary === 'function') {
            try {
              disposeDictionary()
            } catch (e) {
              /* dictionary cleanup is best-effort */
            }
          }
        }
      }
      let resourcesRan = false
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => {
            resourcesRan = true
            return registerClientResources()
          }, 'dsh-ollama-statistical: client resources')
        }
      } catch (e) {
        resourcesRan = false
      }
      if (!resourcesRan) {
        try {
          registerClientResources()
        } catch (e) {
          /* resources are best-effort; rendering must still work */
        }
      }

      const t = createTranslator(locale)
      const langOf = () => detectLang(locale)

      function callRpc(endpoint, payload) {
        let pending
        try {
          if (connection === null || connection === undefined || !connection.rpc || typeof connection.rpc.call !== 'function') {
            return Promise.resolve({ ok: false, error: { code: 'internal', message: 'connection service unavailable' } })
          }
          pending = connection.rpc.call(RPC_CHANNEL, endpoint, payload || {})
        } catch (e) {
          return Promise.resolve({ ok: false, error: { code: 'internal', message: String((e && e.message) || e) } })
        }
        return Promise.resolve(pending).then(
          (result) => {
            if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') return result
            return { ok: false, error: { code: 'internal', message: 'malformed RPC response' } }
          },
          (error) => ({ ok: false, error: { code: 'network', message: String((error && error.message) || error) } })
        )
      }

      function every(fn, ms) {
        try {
          if (ctx && typeof ctx.interval === 'function') {
            const dispose = ctx.interval(fn, ms)
            if (typeof dispose === 'function') return dispose
          }
        } catch (e) {
          /* fall through to a window timer */
        }
        if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return () => {}
        const id = window.setInterval(fn, ms)
        return () => { window.clearInterval(id) }
      }

      /** 一次性定时器（与 every 同风格：优先 ctx.timeout，退化 window.setTimeout）。 */
      function later(fn, ms) {
        try {
          if (ctx && typeof ctx.timeout === 'function') {
            const dispose = ctx.timeout(fn, ms)
            if (typeof dispose === 'function') return dispose
          }
        } catch (e) {
          /* fall through to a window timer */
        }
        if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') return () => {}
        const id = window.setTimeout(fn, ms)
        return () => { window.clearTimeout(id) }
      }

      /* ── 小组件 ─────────────────────────────────────────────── */

      function SectionHead(props) {
        return h('div', { className: 'osta-section-head' },
          h('div', { className: 'osta-section-title' }, props.icon, h('span', null, props.title)),
          props.meta ? h('div', { className: 'osta-section-meta' }, props.meta) : null
        )
      }

      function Metric(props) {
        return h('div', { className: 'osta-metric', title: props.title || props.hint || undefined },
          h('div', { className: 'osta-metric-label' }, props.label),
          h('div', { className: 'osta-metric-value' }, props.value)
        )
      }

      function MiniStat(props) {
        return h('div', { className: 'osta-mini', title: props.title || undefined },
          h('div', { className: 'osta-mini-label' }, props.label),
          h('div', { className: 'osta-mini-value' }, props.value)
        )
      }

      /* ── A. 限额区 ──────────────────────────────────────────── */

      function LimitCard(props) {
        const lang = langOf()
        const data = props.data || {}
        const used = maybeNum(data.usedPercent)
        const remaining = maybeNum(data.remainingPercent) !== null
          ? maybeNum(data.remainingPercent)
          : (used === null ? null : Math.round((100 - used) * 100) / 100)
        const tone = toneOf(used)
        const width = used === null ? 0 : clamp(used, 0, 100)
        // OpenCode 卡用 toneFill 渐变；Ollama 卡保持单一语义色（默认行为不变）。
        const fill = props.gradientFill === true ? toneFill(used) : toneColor(used)
        const resetIn = countdownText(t, data.resetsAt)
        return h('article', { className: 'osta-card' },
          h('div', { className: 'osta-card-head' },
            h('div', { className: 'osta-card-main' },
              h('div', { className: 'osta-card-headline' },
                h('div', { className: 'osta-card-title', title: props.title }, props.title)
              ),
              props.note ? h('div', { className: 'osta-card-sub' }, props.note) : null
            ),
            h('div', { className: 'osta-card-side' },
              h('span', { className: 'osta-chip', 'data-tone': tone }, t('limits.tone.' + tone)),
              props.estimate
                ? h('span', {
                    className: 'osta-estimate-inline',
                    // Ollama 不传 estimateHint → 行为不变；OpenCode 传自己的口径说明。
                    title: typeof props.estimateHint === 'string' && props.estimateHint !== '' ? props.estimateHint : t('limits.estimateHint'),
                  }, t('limits.estimateCompact', {
                    total: fmtCompact(props.estimate.total, lang),
                    used: fmtCompact(props.estimate.used, lang),
                    remaining: fmtCompact(props.estimate.remaining, lang),
                  }))
                : null
            )
          ),
          h('div', { className: 'osta-limit-values' },
            h('div', { className: 'osta-limit-primary' },
              h('div', null,
                h('span', { className: 'osta-bignum' }, used === null ? '—' : fmtNum(used, 'plain', lang)),
                h('span', { className: 'osta-bigpct' }, '%')
              ),
              h('div', { className: 'osta-limlabel' }, t('limits.used'))
            ),
            h('div', { className: 'osta-limsecondary' },
              t('limits.remaining') + ' ' + (remaining === null ? '—' : fmtPct(remaining, lang))
            )
          ),
          h('div', {
            className: 'osta-track',
            role: 'progressbar',
            'aria-label': props.title,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': used === null ? 0 : Math.round(used),
            'aria-valuetext': used === null ? '—' : fmtPct(used, lang),
          },
            h('div', { className: 'osta-fill', style: { width: width + '%', background: fill } })
          ),
          h('div', { className: 'osta-note' },
            h('span', { className: 'osta-note-item' }, resetIn === null ? t('limits.resetUnknown') : t('limits.resetIn', { time: resetIn })),
            data.resetsAt ? h('span', { className: 'osta-note-item', title: String(data.resetsAt) }, t('limits.resetAt', { time: fmtLocal(data.resetsAt) })) : null,
            // OpenCode 卡额外显示上游 status 说明；Ollama 卡不传该字段，渲染完全不变。
            props.statusText ? h('span', { className: 'osta-note-item osta-note-status' }, props.statusText) : null
          )
        )
      }

      function CreditsCard(props) {
        const lang = langOf()
        const credits = props.credits || {}
        const remaining = maybeNum(credits.remainingUsd)
        const allowance = maybeNum(credits.allowanceUsd)
        const used = remaining !== null && allowance !== null && allowance > 0
          ? clamp(((allowance - remaining) / allowance) * 100, 0, 100)
          : null
        return h('article', { className: 'osta-card' },
          h('div', { className: 'osta-card-head' },
            h('div', { className: 'osta-card-main' },
              h('div', { className: 'osta-card-title' }, t('limits.creditsTitle'))
            ),
            h('span', { className: 'osta-chip', 'data-tone': toneOf(used) }, t('limits.tone.' + toneOf(used)))
          ),
          h('div', { className: 'osta-limit-values' },
            h('div', { className: 'osta-limit-primary' },
              h('div', null,
                h('span', { className: 'osta-bignum' }, fmtUsd(remaining, lang))
              ),
              h('div', { className: 'osta-limlabel' }, t('limits.remaining'))
            ),
            h('div', { className: 'osta-limsecondary' }, t('limits.creditAllowance', { usd: fmtUsd(allowance, lang) }))
          ),
          h('div', {
            className: 'osta-track',
            role: 'progressbar',
            'aria-label': t('limits.creditsTitle'),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': used === null ? 0 : Math.round(used),
          },
            h('div', { className: 'osta-fill', style: { width: (used === null ? 0 : used) + '%', background: toneColor(used) } })
          ),
          (credits.periodFrom || credits.periodUntil)
            ? h('div', { className: 'osta-note' },
                h('span', { className: 'osta-note-item' }, t('limits.period', { from: fmtUtcShort(credits.periodFrom), until: fmtUtcShort(credits.periodUntil) }))
              )
            : null
        )
      }

      /**
       * Key 输入表单。Ollama / OpenCode 两个表单会同时出现在页面上（A 区左右两栏、
       * 无 key 视图），因此 input id / label / placeholder 全部可覆盖，避免 id 冲突
       * （label htmlFor 指向错误输入框）。
       */
      function KeyForm(props) {
        const inputId = typeof props.inputId === 'string' && props.inputId !== '' ? props.inputId : 'osta-key-input'
        const label = typeof props.label === 'string' && props.label !== '' ? props.label : t('key.label')
        const placeholder = typeof props.placeholder === 'string' && props.placeholder !== '' ? props.placeholder : t('key.placeholder')
        const busy = props.busy === true
        const value = typeof props.value === 'string' ? props.value : ''
        return h('form', {
          className: 'osta-keyform',
          onSubmit: (event) => {
            event.preventDefault()
            props.onSubmit()
          },
        },
          h('label', { className: 'osta-sr', htmlFor: inputId }, label),
          h('input', {
            id: inputId,
            className: 'osta-input osta-input-wide',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder,
            'aria-label': label,
            value,
            disabled: busy,
            onChange: (event) => props.onChange(event.target.value),
          }),
          h('button', {
            className: 'osta-btn osta-btn-primary',
            type: 'submit',
            disabled: busy || value.trim() === '',
            'aria-busy': busy ? 'true' : 'false',
          }, busy ? t('key.submitting') : t('key.submit'))
        )
      }

      function KeyGuide(props) {
        return h('div', { className: 'osta-card osta-guide' },
          h('div', { className: 'osta-card-head' },
            h('div', { className: 'osta-card-main' },
              h('div', { className: 'osta-card-title' }, t('key.title')),
              h('div', { className: 'osta-card-sub' }, t('key.desc'))
            ),
            h(IconKey)
          ),
          h('ol', { className: 'osta-steps' },
            h('li', null, t('key.step1')),
            h('li', null, t('key.step2')),
            h('li', null,
              h('a', { className: 'osta-link', href: 'https://ollama.com/settings/keys', target: '_blank', rel: 'noreferrer' }, 'ollama.com/settings/keys'),
              ' — ',
              t('key.step3')
            )
          ),
          h(KeyForm, { value: props.value, busy: props.busy, onChange: props.onChange, onSubmit: props.onSubmit }),
          props.error ? h('div', { className: 'osta-error', role: 'alert' }, errText(props.error, t)) : null,
          h('div', { className: 'osta-card-sub' }, t('key.persist'))
        )
      }

      function KeyBar(props) {
        const title = typeof props.title === 'string' && props.title !== '' ? props.title : t('key.barTitle')
        const sub = typeof props.sub === 'string' && props.sub !== '' ? props.sub : t('key.barSub')
        return h('div', { className: 'osta-keybar' },
          h('div', { className: 'osta-keybar-head' },
            h(IconKey),
            h('div', { className: 'osta-keybar-text' },
              h('div', { className: 'osta-keybar-title' }, title),
              h('div', { className: 'osta-keybar-sub' }, sub)
            )
          ),
          h(KeyForm, {
            value: props.value,
            busy: props.busy,
            inputId: props.inputId,
            label: props.label,
            placeholder: props.placeholder,
            onChange: props.onChange,
            onSubmit: props.onSubmit,
          }),
          props.error ? h('div', { className: 'osta-error', role: 'alert' }, errText(props.error, t)) : null
        )
      }

      /**
       * v0.9 页头内联「配置 Key」面板：只为未配置的 provider 渲染 KeyBar
       *（Ollama / OpenCode 可同时配置）。保存仍走 StatPage 的 doSetKey(provider, token)，
       * 成功后 refresh 并自动关闭面板；已配置 provider 的更换/清除仍在各自 A 区。
       * 无 hooks，可安全地按条件返回 null。
       */
      function KeyPanel(props) {
        const bars = []
        if (props.showOllama === true) {
          bars.push(h(KeyBar, {
            key: 'ollama',
            value: props.ollamaValue,
            busy: props.ollamaBusy,
            error: props.ollamaError,
            inputId: 'osta-key-panel-ollama',
            label: t('key.label'),
            placeholder: t('key.placeholder'),
            title: t('key.ollamaBarTitle'),
            sub: t('key.ollamaBarSub'),
            onChange: props.onOllamaChange,
            onSubmit: props.onOllamaSubmit,
          }))
        }
        if (props.showOpencode === true) {
          // v0.9.1：插件级移除后，面板里说明「外部配置未删除」并提供「恢复外部 Key」；
          // KeyBar 保留，粘贴新 Key 保存后 set-key 会清掉 disabled 标志自动恢复。
          const disabledNotice = props.opencodeDisabled === true
            ? h('div', { className: 'osta-keypanel-notice', key: 'oc-disabled' },
                h('div', { className: 'osta-keypanel-notice-text' },
                  h('div', null, t('opencode.disabledHint')),
                  h('div', null, t('opencode.restoreHint'))
                ),
                h('button', {
                  className: 'osta-btn osta-btn-sm',
                  type: 'button',
                  disabled: props.opencodeBusy === true,
                  onClick: () => {
                    if (typeof props.onRestoreOpencode === 'function') props.onRestoreOpencode()
                  },
                }, props.opencodeBusy === true ? t('opencode.restoring') : t('opencode.restoreKey'))
              )
            : null
          bars.push(h('div', { className: 'osta-keypanel-col', key: 'opencode' },
            disabledNotice,
            h(KeyBar, {
              value: props.opencodeValue,
              busy: props.opencodeBusy,
              error: props.opencodeError,
              inputId: 'osta-key-panel-opencode',
              label: t('opencode.label'),
              placeholder: t('opencode.placeholder'),
              title: t('key.opencodeBarTitle'),
              sub: t('key.opencodeBarSub'),
              onChange: props.onOpencodeChange,
              onSubmit: props.onOpencodeSubmit,
            })
          ))
        }
        if (bars.length === 0) return null
        return h('section', {
          id: 'osta-key-panel',
          className: 'osta-keypanel',
          'aria-label': t('key.panelTitle'),
        },
          h('div', { className: 'osta-keypanel-head' },
            h('div', { className: 'osta-keypanel-main' },
              h('div', { className: 'osta-keypanel-title' }, t('key.panelTitle')),
              h('div', { className: 'osta-keypanel-sub' }, t('key.panelSub'))
            ),
            h('button', {
              className: 'osta-btn osta-btn-sm',
              type: 'button',
              onClick: () => {
                if (typeof props.onClose === 'function') props.onClose()
              },
            }, t('key.close'))
          ),
          h('div', { className: 'osta-keypanel-grid' }, bars),
          h('div', { className: 'osta-keypanel-hint' }, t('key.panelHint'))
        )
      }

      function LimitsSection(props) {
        const lang = langOf()
        const limits = props.limits || {}
        const keyInfo = props.keyInfo || {}
        const noKey = !keyInfo.source || keyInfo.source === 'none'
        // 已有 Key 时也可以点「更换 Key」展开输入框（保存后覆盖当前使用的 Key）。
        const editingState = React.useState(false)
        const editingKey = editingState[0]
        const setEditingKey = editingState[1]
        const showKeyBar = noKey || editingKey
        const kind = typeof limits.kind === 'string' ? limits.kind : 'none'
        const session = limits.session || null
        const weekly = limits.weekly || null
        const credits = limits.credits || null
        // 会话限额是「每 5 小时」滚动窗口：用下一次重置时间反推本窗口起始时间，
        // 在卡片标题下显示「本窗口 xx 开始」，与周卡的「每周一 00:00 开始新的一周」对齐。
        const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000
        const sessionResetMs = session && typeof session.resetsAt === 'string' ? Date.parse(session.resetsAt) : NaN
        const sessionNote = !session
          ? null
          : Number.isFinite(sessionResetMs)
            ? t('limits.sessionNote', { start: fmtLocal(new Date(sessionResetMs - SESSION_WINDOW_MS).toISOString()) })
            : t('limits.sessionNotePlain')
        // 周额度 token 估算：本机 ollama provider 在「本周（周一开始 → 今天）」的 token 合计 ÷ 官方已用百分比，
        // 反推周总额度 / 已用 / 剩余。限额属于 OLLAMA_API_KEY 账号，所以只统计 ollama provider。
        // 注意：必须在构造 cards 之前算好（周卡会直接引用 weeklyEstimate）。
        const tokens = props.tokens !== null && typeof props.tokens === 'object' ? props.tokens : {}
        const weekStart = typeof tokens.weekStart === 'string' ? tokens.weekStart : null
        const tokenToday = typeof tokens.today === 'string' ? tokens.today : null
        const ollamaProvider = Array.isArray(tokens.providers)
          ? tokens.providers.find((provider) => provider && provider.provider === 'ollama')
          : null
        let weeklyUsedTokens = null
        if (weekStart !== null && tokenToday !== null && ollamaProvider && Array.isArray(ollamaProvider.days)) {
          weeklyUsedTokens = ollamaProvider.days
            .filter((day) => day && typeof day.date === 'string' && day.date >= weekStart && day.date <= tokenToday)
            .reduce((sum, day) => sum + num(day.total), 0)
        }
        const weeklyPct = weekly ? maybeNum(weekly.usedPercent) : null
        const weeklyEstimate = weeklyPct !== null && weeklyPct >= 1
          ? estimateQuotaTokens(weeklyPct, weeklyUsedTokens)
          : null
        const cards = []
        if (kind === 'credits' && credits) {
          cards.push(h(CreditsCard, { key: 'credits', credits }))
        } else {
          if (session) {
            cards.push(h(LimitCard, {
              key: 'session',
              title: t('limits.session'),
              data: session,
              note: sessionNote,
            }))
          }
          if (weekly) {
            cards.push(h(LimitCard, {
              key: 'weekly',
              title: t('limits.weekly'),
              data: weekly,
              note: t('limits.weekNote'),
              estimate: weeklyEstimate,
            }))
          }
        }
        const purchased = maybeNum(limits.purchasedUsd)
        return h('section', { className: 'osta-section' },
          h(SectionHead, {
            icon: h(IconLimits),
            title: t('limits.title'),
            meta: [
              h('span', {
                key: 'keysource',
                className: 'osta-chip',
                'data-tone': noKey ? 'warn' : undefined,
                title: t('limits.keySource', { source: sourceLabel(keyInfo.source, t), masked: keyInfo.masked || '—' }),
              }, noKey
                ? t('key.none')
                : sourceLabel(keyInfo.source, t) + (keyInfo.masked ? ' · ' + keyInfo.masked : '')
              ),
              (noKey
                ? null
                : h('button', {
                    key: 'editkey',
                    className: 'osta-btn osta-btn-sm',
                    type: 'button',
                    'aria-expanded': editingKey === true ? 'true' : 'false',
                    onClick: () => setEditingKey(!editingKey),
                  }, editingKey === true ? t('key.cancel') : t('limits.editKey'))),
              (keyInfo.source === 'manual' && props.onClearKey)
                ? h('button', {
                    key: 'clearkey',
                    className: 'osta-btn osta-btn-sm',
                    type: 'button',
                    disabled: props.keyBusy === true,
                    onClick: props.onClearKey,
                  }, props.keyBusy === true ? t('limits.clearing') : t('limits.clearManual'))
                : null,
            ],
          }),
          showKeyBar
            ? h(KeyBar, {
                value: props.keyValue,
                busy: props.keyBusy,
                error: props.keyError,
                title: noKey ? undefined : t('key.changeTitle'),
                sub: noKey ? undefined : t('key.changeSub'),
                onChange: props.onKeyChange,
                onSubmit: props.onKeySubmit,
              })
            : null,
          cards.length > 0
            ? h('div', { className: 'osta-grid' }, cards)
            : h('div', { className: 'osta-card' }, h('div', { className: 'osta-card-sub' }, t('limits.none'))),
          purchased !== null
            ? h('div', { className: 'osta-note' },
                h('span', { className: 'osta-note-item' }, t('limits.purchased', { usd: fmtUsd(purchased, lang) }))
              )
            : null
        )
      }

      /* ── A2. OpenCode Go 限额区（v0.8 增量）──────────────────── */

      /**
       * 右侧 OpenCode Go 区：
       *  - 标题 + key chip（来源 + 脱敏）+「更换 Key」/「清除手动 Key」；
       *  - 无 key（或正在更换）→ KeyBar（提示优先复用 opencode CLI 登录的 Key）；
       *  - kind === 'go' 且有 usage → 三张窗口卡（滚动 5h / 周 / 月，复用 LimitCard）；
       *  - configured 且 kind === 'none' → 空态卡（无 Go 订阅 / 接口失败）；
       *  - errors 里的 opencode 错误 → 顶部小错误条（有旧 usage 时卡片照常渲染）；
       *  - local !== null → 本机 CLI 用量条（今天/本周/本月 一行三列）。
       * 注意：snap.opencode 在旧 host 上整体缺失，此时按「未配置」渲染，不报错。
       */
      function OpenCodeLimitsSection(props) {
        const lang = langOf()
        const state = opencodeState(props.opencode)
        const errors = Array.isArray(props.errors) ? props.errors : []
        const errorEntry = findSourceError(errors, 'opencode')
        const editing = props.editing === true
        const keyBusy = props.keyBusy === true
        const showKeyBar = state.configured === false || editing
        const rows = opencodeWindowRows(state.present ? props.opencode : null)
        const hasUsage = state.usage !== null && rows.some((row) => row.usedPercent !== null)
        const keyText = state.configured
          ? sourceLabel(state.key.source, t) + (state.key.masked ? ' · ' + state.key.masked : '')
          : t('opencode.noKey')

        // v0.9.4：用本机 opencode.db 的窗口用量反推额度总量（与 Ollama 周卡同一套 estimateQuotaTokens）。
        const estimates = opencodeQuotaEstimates(state.local)
        const cards = []
        if (hasUsage) {
          rows.forEach((row) => {
            const usedPct = row.usedPercent
            const estimate = usedPct !== null && usedPct >= 1
              ? estimateQuotaTokens(usedPct, estimates[row.key])
              : null
            cards.push(h(LimitCard, {
              key: row.key,
              title: t(row.titleKey),
              data: {
                usedPercent: row.usedPercent,
                remainingPercent: row.remainingPercent,
                resetsAt: row.resetsAt,
              },
              note: t(row.subKey),
              gradientFill: true,
              estimate,
              estimateHint: t('opencode.estimateHint'),
              statusText: row.status === null
                ? null
                : (row.status === 'ok' ? t('opencode.statusOk') : t('opencode.statusWarn', { status: row.status })),
            }))
          })
        }

        const emptyCard = state.configured && cards.length === 0
          ? h('div', { className: 'osta-card' },
              h('div', { className: 'osta-card-head' },
                h('div', { className: 'osta-card-main' },
                  h('div', { className: 'osta-card-title' }, errorEntry !== null ? t('opencode.failed') : t('opencode.empty')),
                  // 空态说明一律走 i18n；host 的 note 是中文兜底文案，不直接展示（英文界面会串语言）。
                  h('div', { className: 'osta-card-sub' }, errorEntry !== null ? t('opencode.failedHint') : t('opencode.emptyHint'))
                ),
                h(IconAlert)
              )
            )
          : null

        return h('section', { className: 'osta-section' },
          h(SectionHead, {
            icon: h(IconLimits),
            title: t('opencode.title'),
            meta: [
              h('span', {
                key: 'keysource',
                className: 'osta-chip',
                'data-tone': state.configured ? undefined : 'warn',
                title: t('opencode.keySource', { source: sourceLabel(state.key.source, t), masked: state.key.masked || '—' }),
              }, keyText),
              state.configured
                ? h('button', {
                    key: 'editkey',
                    className: 'osta-btn osta-btn-sm',
                    type: 'button',
                    'aria-expanded': editing ? 'true' : 'false',
                    onClick: () => {
                      if (typeof props.onToggleEditing === 'function') props.onToggleEditing()
                    },
                  }, editing ? t('key.cancel') : t('opencode.editKey'))
                : null,
              (state.key.source === 'manual' && typeof props.onClearKey === 'function')
                ? h('button', {
                    key: 'clearkey',
                    className: 'osta-btn osta-btn-sm',
                    type: 'button',
                    disabled: keyBusy,
                    onClick: () => { props.onClearKey() },
                  }, keyBusy ? t('opencode.clearing') : t('opencode.clearManual'))
                : null,
              // v0.9.1：任何 Key 来源都显示「移除 Key」＝插件级停用（不删除外部环境变量 / CLI 登录）。
              typeof props.onRemoveKey === 'function'
                ? h('button', {
                    key: 'removekey',
                    className: 'osta-btn osta-btn-sm',
                    type: 'button',
                    disabled: keyBusy,
                    title: t('opencode.removeKeyHint'),
                    'aria-busy': keyBusy ? 'true' : 'false',
                    onClick: () => { props.onRemoveKey() },
                  }, keyBusy ? t('opencode.removing') : t('opencode.removeKey'))
                : null,
            ],
          }),
          errorEntry !== null
            ? h('div', { className: 'osta-errorbar', role: 'alert' },
                h(IconAlert),
                h('span', null, errText(errorEntry, t))
              )
            : null,
          showKeyBar
            ? h(KeyBar, {
                value: props.keyValue,
                busy: keyBusy,
                error: props.keyError,
                inputId: 'osta-opencode-key-input',
                label: t('opencode.label'),
                placeholder: t('opencode.placeholder'),
                title: state.configured ? t('opencode.changeTitle') : t('opencode.barTitle'),
                sub: state.configured ? t('opencode.changeSub') : t('opencode.barSub'),
                onChange: props.onKeyChange,
                onSubmit: props.onKeySubmit,
              })
            : null,
          cards.length > 0 ? h('div', { className: 'osta-oc-grid' }, cards) : emptyCard,
          cards.length > 0 ? h('div', { className: 'osta-oc-note' }, t('opencode.note')) : null
        )
      }

      /* ── A3. 本机 OpenCode CLI 用量（v0.9.3：三张官方用量卡）── */

      /**
       * 单张本机用量卡：版式与 Ollama 官方请求量卡一致——
       * 标题 + 大号 token 数 + 单位 Token + Sparkline + 日期范围 + mini 统计（输入/缓存读/输出/费用）。
       * bucket 为 null（该时段没有 totals）时只显示空态说明。
       */
      function OpenCodeLocalCard(props) {
        const lang = langOf()
        const bucket = props.bucket !== null && props.bucket !== undefined && typeof props.bucket === 'object' ? props.bucket : null
        const total = bucket === null ? null : maybeNum(bucket.total)
        const requests = bucket === null ? null : maybeNum(bucket.requests)
        const buckets = Array.isArray(props.buckets) ? props.buckets : []
        const from = typeof props.from === 'string' && props.from !== '' ? props.from : null
        const to = typeof props.to === 'string' && props.to !== '' ? props.to : null
        const range = from === null
          ? null
          : (to === null || from === to ? from : t('opencode.localRange', { from, to }))
        return h('article', { className: 'osta-card' },
          h('div', { className: 'osta-card-head' },
            h('div', { className: 'osta-card-main' },
              h('div', { className: 'osta-card-title' }, props.title)
            ),
            requests === null
              ? null
              : h('span', { className: 'osta-chip' }, t('opencode.localMeta', { requests: fmtInt(requests, lang) }))
          ),
          h('div', { className: 'osta-official-head' },
            h('span', { className: 'osta-official-num' }, fmtToken(total, lang)),
            h('span', { className: 'osta-total-unit' }, t('opencode.localTokenUnit'))
          ),
          h(Sparkline, { buckets, valueKey: 'total' }),
          range === null ? null : h('div', { className: 'osta-card-sub' }, range),
          bucket === null
            ? h('div', { className: 'osta-card-sub' }, t('error.noData'))
            : h('div', { className: 'osta-mini-grid' },
                h(MiniStat, { label: t('tokens.input'), value: fmtCompact(bucket.input, lang) }),
                h(MiniStat, { label: t('tokens.cacheRead'), value: fmtCompact(bucket.cacheRead, lang) }),
                h(MiniStat, { label: t('tokens.output'), value: fmtCompact(bucket.output, lang) }),
                h(MiniStat, { label: t('opencode.localCost'), value: fmtUsd(bucket.costUsd, lang) })
              )
        )
      }

      /**
       * 本机 opencode CLI 用量（全宽，放在 A 区之后、B 区之前）。三张卡：今天 / 本周 / 本月：
       *  - 今天：sparkline 用 local.hours（24 个小时桶）；旧 host 没有 hours 时回退为「今天的单个日桶」；
       *  - 本周 / 本月：sparkline 用 local.days 在周窗口 / 月窗口内的日桶；
       *  - 底部说明与 DSH 会话日志口径不同。显隐由调用方按 showOpenCode + local 控制。
       */
      function OpenCodeLocalSection(props) {
        const lang = langOf()
        const summary = opencodeLocalSummary(props.local)
        if (summary === null) return null
        const inRange = (from, to) => summary.days.filter((day) => {
          if (from !== null && day.date < from) return false
          if (to !== null && day.date > to) return false
          return true
        })
        const todayBuckets = summary.hours.length > 0
          ? summary.hours
          : (summary.today !== null ? [{ total: summary.today.total, requests: summary.today.requests }] : [])
        const defs = [
          { key: 'today', title: t('opencode.localToday'), bucket: summary.today, buckets: todayBuckets, from: summary.todayDate, to: summary.todayDate },
          { key: 'week', title: t('opencode.localWeek'), bucket: summary.week, buckets: inRange(summary.weekStart, summary.todayDate), from: summary.weekStart, to: summary.todayDate },
          { key: 'month', title: t('opencode.localMonth'), bucket: summary.month, buckets: inRange(summary.monthStart, summary.todayDate), from: summary.monthStart, to: summary.todayDate },
        ]
        return h('section', { className: 'osta-section osta-oc-local-section' },
          h(SectionHead, {
            icon: h(IconTokens),
            title: t('opencode.localTitle'),
            meta: h('span', null, t('opencode.localHint', {
              days: fmtInt(summary.windowDays, lang),
              tz: summary.timeZone === null ? '—' : summary.timeZone,
            })),
          }),
          h('div', { className: 'osta-grid osta-grid-3' },
            defs.map((def) => h(OpenCodeLocalCard, {
              key: def.key,
              title: def.title,
              bucket: def.bucket,
              buckets: def.buckets,
              from: def.from,
              to: def.to,
            }))
          ),
          h('div', { className: 'osta-card-sub' }, t('opencode.localNote'))
        )
      }

      /* ── B. Token 统计区 ────────────────────────────────────── */

      /**
       * 多序列 SVG 趋势图（无第三方库 / canvas）：
       * 左轴 token（紧凑格式）、右轴缓存命中率 %、顶部图例、折线 + Input 面积、圆点标记。
       * 颜色只用于数据可视化；网格/坐标文字走 --dsw-* 主题变量。
       */
      function TrendChart(props) {
        const lang = langOf()
        const trend = props.trend !== null && typeof props.trend === 'object'
          ? props.trend
          : { mode: 'day', points: [] }
        const points = Array.isArray(trend.points) ? trend.points : []
        const isHour = trend.mode === 'hour'
        const count = points.length
        // active = {index, y}：y 是鼠标相对 .osta-trend-plot 顶部的像素（键盘兜底用 40% 高度）。
        const plotRef = React.useRef(null)
        const activeState = React.useState(null)
        const active = activeState[0]
        const setActive = activeState[1]
        const validActive = active !== null && typeof active === 'object'
          && typeof active.index === 'number' && active.index >= 0 && active.index < count
          ? active.index
          : null
        const rawActiveY = active !== null && typeof active === 'object' ? maybeNum(active.y) : null
        const W = 1000
        const H = 200
        const PL = 54
        const PR = 48
        const PT = 10
        const PB = 22
        const plotW = W - PL - PR
        const plotH = H - PT - PB
        let rawMax = 0
        points.forEach((point) => {
          rawMax = Math.max(rawMax, num(point.input), num(point.output), num(point.cacheRead), num(point.cacheWrite))
        })
        const tokenMax = niceCeil(rawMax)
        const showCreation = points.some((point) => num(point.cacheWrite) > 0)
        const showHit = points.some((point) => point.hitRate !== null && point.hitRate !== undefined)
        const xAt = (index) => (count <= 1 ? PL + plotW / 2 : PL + (index / (count - 1)) * plotW)
        const yToken = (value) => PT + plotH - (clamp(num(value), 0, tokenMax) / tokenMax) * plotH
        const yRate = (value) => PT + plotH - (clamp(num(value), 0, 100) / 100) * plotH
        // tooltip 跟随鼠标垂直位置：高度取真实 DOM 像素（无 DOM/未挂载时用估计值），
        // 键盘聚焦没有 clientY 时按绘图区 40% 高度兜底。
        const FALLBACK_PLOT_PX = 320
        const TOOLTIP_EST_H = 170
        const plotPixelHeight = () => {
          const node = plotRef.current
          if (node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function') {
            const rect = node.getBoundingClientRect()
            if (rect && Number.isFinite(rect.height) && rect.height > 0) return rect.height
          }
          return FALLBACK_PLOT_PX
        }
        const activateAt = (index, event) => {
          let y = null
          const node = plotRef.current
          if (node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function'
            && event && typeof event.clientY === 'number' && Number.isFinite(event.clientY)) {
            const rect = node.getBoundingClientRect()
            if (rect && Number.isFinite(rect.top)) y = event.clientY - rect.top
          }
          const height = plotPixelHeight()
          if (y === null || !Number.isFinite(y)) y = height * 0.4
          setActive({ index, y: clamp(y, 0, height) })
        }
        const linePath = (values) => {
          if (count === 0) return ''
          return values.map((value, index) => (index === 0 ? 'M' : 'L') + xAt(index).toFixed(2) + ' ' + yToken(value).toFixed(2)).join(' ')
        }
        const areaPath = (values) => {
          if (count < 2) return ''
          const base = PT + plotH
          return 'M' + xAt(0).toFixed(2) + ' ' + base.toFixed(2) + ' '
            + values.map((value, index) => 'L' + xAt(index).toFixed(2) + ' ' + yToken(value).toFixed(2)).join(' ')
            + ' L' + xAt(count - 1).toFixed(2) + ' ' + base.toFixed(2) + ' Z'
        }
        const ratePath = () => {
          let path = ''
          let pen = false
          points.forEach((point, index) => {
            if (point.hitRate === null || point.hitRate === undefined) {
              pen = false
              return
            }
            path += (pen ? 'L' : 'M') + xAt(index).toFixed(2) + ' ' + yRate(point.hitRate).toFixed(2) + ' '
            pen = true
          })
          return path.trim()
        }
        const seriesDefs = [
          { key: 'input', label: t('tokens.input'), color: TREND_COLORS.input, values: points.map((point) => point.input) },
          { key: 'output', label: t('tokens.output'), color: TREND_COLORS.output, values: points.map((point) => point.output) },
        ]
        if (showCreation) {
          seriesDefs.push({ key: 'cacheWrite', label: t('tokens.cacheWrite'), color: TREND_COLORS.cacheWrite, values: points.map((point) => point.cacheWrite) })
        }
        seriesDefs.push({ key: 'cacheRead', label: t('tokens.cacheRead'), color: TREND_COLORS.cacheRead, values: points.map((point) => point.cacheRead) })
        const legendItems = seriesDefs.map((series) => ({ key: series.key, label: series.label, color: series.color }))
        if (showHit) legendItems.push({ key: 'hitRate', label: t('tokens.hitRate'), color: TREND_COLORS.hitRate })
        const pointTitle = (point) => {
          const lines = [point.hint || point.label || '']
          lines.push(t('tokens.input') + ': ' + fmtCompact(point.input, lang))
          lines.push(t('tokens.output') + ': ' + fmtCompact(point.output, lang))
          lines.push(t('tokens.cacheRead') + ': ' + fmtCompact(point.cacheRead, lang))
          if (showCreation) lines.push(t('tokens.cacheWrite') + ': ' + fmtCompact(point.cacheWrite, lang))
          lines.push(t('tokens.total') + ': ' + fmtCompact(point.total, lang))
          lines.push(t('tokens.requests') + ': ' + fmtInt(point.requests, lang))
          if (showHit) lines.push(t('tokens.hitRate') + ': ' + fmtPct(point.hitRate, lang))
          return lines.join('\n')
        }
        // x 轴刻度：小时态每 3 小时一个（00/03/…/21）；天态约 6 个（含首尾）。
        let tickIndices
        if (isHour) {
          tickIndices = []
          for (let i = 0; i < count; i += 3) tickIndices.push(i)
        } else if (count <= 6) {
          tickIndices = points.map((point, index) => index)
        } else {
          const set = []
          for (let k = 0; k <= 5; k += 1) set.push(Math.round((k * (count - 1)) / 5))
          tickIndices = set.filter((value, index) => set.indexOf(value) === index)
        }
        // 网格线与百分比刻度共用同一组水平线（0/20/…/100%），
        // 左轴 token 标签落在同一条线上，右轴百分比也正好压在虚线上。
        const rateTicks = [0, 20, 40, 60, 80, 100]
        const gridFractions = rateTicks.map((value) => value / 100)
        // 自定义即时 tooltip（替代/补充 SVG 原生 <title>）：跟随当前 hover/focus 的点。
        const activePoint = validActive === null ? null : points[validActive]
        const tipRows = []
        if (activePoint !== null) {
          tipRows.push({ key: 'input', label: t('tokens.input'), value: fmtCompact(activePoint.input, lang), color: TREND_COLORS.input })
          tipRows.push({ key: 'output', label: t('tokens.output'), value: fmtCompact(activePoint.output, lang), color: TREND_COLORS.output })
          if (showCreation) {
            tipRows.push({ key: 'cacheWrite', label: t('tokens.cacheWrite'), value: fmtCompact(activePoint.cacheWrite, lang), color: TREND_COLORS.cacheWrite })
          }
          tipRows.push({ key: 'cacheRead', label: t('tokens.cacheRead'), value: fmtCompact(activePoint.cacheRead, lang), color: TREND_COLORS.cacheRead })
          tipRows.push({ key: 'total', label: t('tokens.total'), value: fmtCompact(activePoint.total, lang), color: 'var(--dsw-alias-label-tertiary)' })
          tipRows.push({ key: 'requests', label: t('tokens.requests'), value: fmtInt(activePoint.requests, lang), color: 'var(--dsw-alias-label-tertiary)' })
          if (activePoint.hitRate !== null && activePoint.hitRate !== undefined) {
            tipRows.push({ key: 'hitRate', label: t('tokens.hitRate'), value: fmtPct(activePoint.hitRate, lang), color: TREND_COLORS.hitRate })
          }
        }
        // 位置：水平按点的 x 百分比 clamp 到 2%~98%；垂直跟随鼠标 y。
        // 翻转避让：y<160 且下方放得下（y+14+估算高度 <= 绘图区高度）→ 鼠标下方，
        // 否则显示在鼠标上方；左右边界仍用 translate 的横向位移切换。
        const tipLeftPct = validActive === null ? 0 : clamp((xAt(validActive) / W) * 100, 2, 98)
        const plotPx = plotPixelHeight()
        const tipY = validActive === null
          ? plotPx * 0.4
          : (rawActiveY === null ? plotPx * 0.4 : rawActiveY)
        const showBelow = tipY < 160 && (tipY + 14 + TOOLTIP_EST_H <= plotPx)
        const verticalShift = showBelow ? '14px' : 'calc(-100% - 12px)'
        const horizontalShift = tipLeftPct < 12 ? '-8px' : (tipLeftPct > 88 ? 'calc(-100% + 8px)' : '-50%')
        const tipTransform = 'translate(' + horizontalShift + ', ' + verticalShift + ')'
        const tooltip = activePoint === null
          ? null
          : h('div', {
              className: 'osta-trend-tip',
              role: 'tooltip',
              style: { left: tipLeftPct + '%', top: tipY + 'px', transform: tipTransform },
            },
              h('div', { className: 'osta-trend-tip-time' }, activePoint.hint || activePoint.label || ''),
              tipRows.map((row) => h('div', { key: row.key, className: 'osta-trend-tip-row' },
                h('span', { className: 'osta-trend-tip-label' },
                  h('span', { className: 'osta-trend-tip-dot', style: { background: row.color } }),
                  row.label
                ),
                h('span', { className: 'osta-trend-tip-value' }, row.value)
              ))
            )
        return h('div', { className: 'osta-trend' },
          h('div', { className: 'osta-trend-legend' },
            legendItems.map((item) => h('span', { key: item.key, className: 'osta-trend-legenditem' },
              h('span', { className: 'osta-trend-dot', style: { background: item.color } }),
              item.label
            ))
          ),
          h('div', {
            className: 'osta-trend-plot',
            ref: plotRef,
            onMouseLeave: () => setActive(null),
          },
          h('svg', {
            className: 'osta-trend-svg',
            viewBox: '0 0 ' + W + ' ' + H,
            preserveAspectRatio: 'xMidYMid meet',
            role: 'img',
            'aria-label': t('tokens.chartAria', {
              from: isHour ? '00:00' : (trend.lo || '—'),
              to: isHour ? '23:59' : (trend.hi || '—'),
            }),
          },
            h('defs', null,
              h('linearGradient', { id: 'osta-trend-input-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
                h('stop', { offset: '0%', stopColor: TREND_COLORS.input, stopOpacity: '0.26' }),
                h('stop', { offset: '100%', stopColor: TREND_COLORS.input, stopOpacity: '0' })
              )
            ),
            gridFractions.map((fraction) => {
              const value = tokenMax * fraction
              const y = yToken(value)
              return h('g', { key: 'grid:' + fraction },
                h('line', { className: 'osta-trend-grid', x1: PL, y1: y, x2: W - PR, y2: y }),
                h('text', {
                  className: 'osta-trend-axislabel',
                  x: PL - 8,
                  y: y + 4,
                  textAnchor: 'end',
                }, fmtCompact(value, lang))
              )
            }),
            h('line', { className: 'osta-trend-baseline', x1: PL, y1: PT + plotH, x2: W - PR, y2: PT + plotH }),
            showHit
              ? h('g', { key: 'rate-axis' },
                  rateTicks.map((value) => h('text', {
                    key: 'rate:' + value,
                    className: 'osta-trend-axislabel osta-trend-axislabel-rate',
                    x: W - PR + 8,
                    y: yRate(value) + 4,
                    textAnchor: 'start',
                  }, value + '%'))
                )
              : null,
            validActive === null
              ? null
              : h('line', {
                  className: 'osta-trend-guide',
                  x1: xAt(validActive),
                  y1: PT,
                  x2: xAt(validActive),
                  y2: PT + plotH,
                }),
            count >= 2
              ? h('path', { className: 'osta-trend-area', d: areaPath(seriesDefs[0].values), fill: 'url(#osta-trend-input-fill)' })
              : null,
            seriesDefs.map((series) => h('path', {
              key: 'line:' + series.key,
              className: 'osta-trend-line',
              d: linePath(series.values),
              stroke: series.color,
              'data-series': series.key,
            })),
            showHit
              ? h('path', {
                  className: 'osta-trend-line',
                  d: ratePath(),
                  stroke: TREND_COLORS.hitRate,
                  strokeDasharray: '5 4',
                  'data-series': 'hitRate',
                })
              : null,
            seriesDefs.map((series) => points.map((point, index) => h('circle', {
              key: 'dot:' + series.key + ':' + index,
              className: 'osta-trend-point',
              cx: xAt(index),
              cy: yToken(series.values[index]),
              r: index === validActive ? 4.5 : 2.5,
              fill: series.color,
              'data-series': series.key,
              'data-active': index === validActive ? 'true' : 'false',
            }, h('title', null, pointTitle(point))))),
            showHit
              ? points.map((point, index) => {
                  if (point.hitRate === null || point.hitRate === undefined) return null
                  return h('circle', {
                    key: 'dot:hitRate:' + index,
                    className: 'osta-trend-point',
                    cx: xAt(index),
                    cy: yRate(point.hitRate),
                    r: index === validActive ? 4.5 : 2.5,
                    fill: TREND_COLORS.hitRate,
                    'data-series': 'hitRate',
                    'data-active': index === validActive ? 'true' : 'false',
                  }, h('title', null, pointTitle(point)))
                })
              : null,
            tickIndices.map((index) => h('text', {
              key: 'xtick:' + index,
              className: 'osta-trend-axislabel',
              x: xAt(index),
              y: H - 8,
              textAnchor: index === 0 ? 'start' : (index === count - 1 ? 'end' : 'middle'),
            }, points[index] ? points[index].label : '')),
            points.map((point, index) => h('rect', {
              key: 'hit:' + index,
              className: 'osta-trend-hit',
              x: PL + (plotW / Math.max(1, count)) * index,
              y: PT,
              width: plotW / Math.max(1, count),
              height: plotH,
              tabIndex: 0,
              role: 'button',
              pointerEvents: 'all',
              'data-index': index,
              'aria-label': (point.hint || point.label || '') + ' ' + fmtCompact(point.total, lang),
              onMouseEnter: (event) => activateAt(index, event),
              onMouseMove: (event) => activateAt(index, event),
              onMouseLeave: () => setActive(null),
              onFocus: (event) => activateAt(index, event),
              onBlur: () => setActive(null),
            })),
            count === 0
              ? h('line', { className: 'osta-trend-baseline', x1: PL, y1: PT + plotH / 2, x2: W - PR, y2: PT + plotH / 2 })
              : null
          ),
          tooltip
          )
        )
      }

      function ModelsList(props) {
        const lang = langOf()
        const allRows = Array.isArray(props.rows) ? props.rows : []
        // 0% 的模型不显示（没有用量的行会白占一行）。
        const rows = allRows.filter((row) => num(row.total) > 0)
        const showProvider = props.showProvider === true
        if (rows.length === 0) {
          return h('div', { className: 'osta-card-sub' }, t('tokens.modelsEmpty'))
        }
        return h('div', { className: 'osta-models' },
          rows.map((row, index) => {
            const name = row.model === '(其余)' ? t('tokens.modelsOther') : String(row.model || '—')
            const provider = showProvider && typeof row.provider === 'string' && row.provider !== ''
              ? row.provider
              : null
            const suffix = row.degraded === true
              ? ' ' + t('tokens.windowValueSuffix')
              : ' · ' + fmtPct(row.share, lang)
            // 单行展示：整行即占比条（浅色填充到 share%），文字叠在上层，视觉与原来的进度条一致。
            const share = row.share === null ? 0 : clamp(row.share, 0, 100)
            return h('div', {
              key: String(row.model || index) + ':' + (provider || '') + (row.degraded === true ? ':window' : ''),
              className: 'osta-model',
              title: fmtInt(row.total, lang) + ' ' + t('tokens.total') + suffix,
            },
              h('span', {
                className: 'osta-model-bar',
                'aria-hidden': 'true',
                style: {
                  width: (share <= 0 ? 0 : Math.max(share, 2)) + '%',
                  background: VIZ_PALETTE[index % VIZ_PALETTE.length],
                },
              }),
              h('span', { className: 'osta-model-title' },
                provider === null ? null : h('span', { className: 'osta-model-provider', title: provider }, provider),
                h('span', { className: 'osta-model-name' }, name)
              ),
              h('span', { className: 'osta-model-value' }, fmtCompact(row.total, lang) + suffix)
            )
          })
        )
      }

      function TokensSection(props) {
        const lang = langOf()
        const tokens = props.tokens
        const tabState = React.useState('today')
        const tab = typeof props.tab === 'string' && props.tab !== '' ? props.tab : tabState[0]
        const setTab = typeof props.onTabChange === 'function' ? props.onTabChange : tabState[1]
        const customState = React.useState(null)
        const custom = props.custom !== null && props.custom !== undefined && typeof props.custom === 'object'
          ? props.custom
          : customState[0]
        const setCustom = typeof props.onCustomChange === 'function' ? props.onCustomChange : customState[1]
        // 筛选状态由 StatPage 持有（C 区显隐依赖它）；这里只读 + 回调。
        const selectedProvider = typeof props.selectedProvider === 'string' && props.selectedProvider !== ''
          ? props.selectedProvider
          : 'all'
        const requestProvider = (providerId) => {
          if (typeof props.onSelectProvider === 'function') props.onSelectProvider(providerId)
        }

        const bounds = boundsOf(tokens)
        const providers = tokenProviders(tokens)
        // 快照更新后原选中供应商可能消失：渲染期回退到「全部」，不切空视图。
        let activeProvider = 'all'
        if (selectedProvider !== 'all') {
          for (let i = 0; i < providers.length; i += 1) {
            if (providers[i].provider === selectedProvider) {
              activeProvider = selectedProvider
              break
            }
          }
        }
        const source = selectTokenSource(tokens, activeProvider)
        // 自定义日期默认覆盖「最近一个月」= 统计窗口的全部 30 天（最早一天到今天）。
        const defaultFrom = bounds.days.length > 0 ? bounds.days[0].date : bounds.first
        const effectiveFrom = custom && custom.from ? custom.from : defaultFrom
        const effectiveTo = custom && custom.to ? custom.to : bounds.today
        const view = computeSourceRange(source, tab, effectiveFrom, effectiveTo)
        const agg = view.agg
        const degraded = view.degraded === true
        const isEmpty = tokens !== null && tokens !== undefined && !degraded && agg.total === 0 && agg.requests === 0
        // 「窗口合计」提示只在 provider 缺 days 明细、整块走 totals 降级时出现。
        const degradedHint = degraded ? t('tokens.providerTotalsHint') : undefined
        const metricTitle = (value) => (degraded ? t('tokens.providerTotalsHint') : fmtInt(value, lang))
        // 柱状图粒度随范围自适应：今天/仅今天的自定义 → 24 小时；其它 → 按天。
        const trend = chartTrend(tokens, source.providerId, tab, effectiveFrom, effectiveTo)
        // chips 与「按供应商分布」统一用「全部」视图的当前范围口径（= hero 的总量），
        // 不随所选供应商变化；切换 tab / 自定义日期时随渲染立即重算。
        const allView = computeSourceRange(selectTokenSource(tokens, 'all'), tab, effectiveFrom, effectiveTo)
        const rangeRows = providerRangeRows(tokens, allView.lo, allView.hi)
        const rangeAllTotal = allView.agg.total
        const rowOf = (providerId) => {
          for (let i = 0; i < rangeRows.length; i += 1) {
            if (rangeRows[i].provider === providerId) return rangeRows[i]
          }
          return null
        }
        const chipTotalOf = (providerId) => {
          const row = rowOf(providerId)
          return row === null ? null : row.total
        }

        const setRange = (side, value) => {
          let nextFrom = side === 'from' ? value : effectiveFrom
          let nextTo = side === 'to' ? value : effectiveTo
          if (nextFrom !== '' && nextTo !== '' && nextFrom > nextTo) {
            const swapped = nextFrom
            nextFrom = nextTo
            nextTo = swapped
          }
          setCustom({ from: nextFrom, to: nextTo })
        }

        const onTabKeyDown = (event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
          event.preventDefault()
          const order = ['today', 'week', 'custom']
          const index = order.indexOf(tab)
          const step = event.key === 'ArrowRight' ? 1 : order.length - 1
          setTab(order[(index + step) % order.length])
        }

        const tabDefs = [
          { key: 'today', label: t('tokens.tabToday') },
          { key: 'week', label: t('tokens.tabWeek') },
          { key: 'custom', label: t('tokens.tabCustom') },
        ]

        const toolbar = h('div', { className: 'osta-toolbar' },
          h('div', { className: 'osta-tabs', role: 'tablist', 'aria-label': t('tokens.title') },
            tabDefs.map((def) => h('button', {
              key: def.key,
              type: 'button',
              className: 'osta-tab',
              role: 'tab',
              id: 'osta-tab-' + def.key,
              'aria-selected': tab === def.key ? 'true' : 'false',
              'aria-controls': 'osta-tabpanel-tokens',
              tabIndex: tab === def.key ? 0 : -1,
              onClick: () => setTab(def.key),
              onKeyDown: onTabKeyDown,
            }, def.label))
          ),
          (tab === 'custom'
            ? h('div', { className: 'osta-range' },
                h('label', { className: 'osta-field' },
                  h('span', null, t('tokens.from')),
                  h('input', {
                    className: 'osta-input',
                    type: 'date',
                    value: effectiveFrom,
                    min: bounds.first || undefined,
                    max: bounds.today || undefined,
                    onChange: (event) => setRange('from', event.target.value),
                    'aria-label': t('tokens.from'),
                  })
                ),
                h('label', { className: 'osta-field' },
                  h('span', null, t('tokens.to')),
                  h('input', {
                    className: 'osta-input',
                    type: 'date',
                    value: effectiveTo,
                    min: bounds.first || undefined,
                    max: bounds.today || undefined,
                    onChange: (event) => setRange('to', event.target.value),
                    'aria-label': t('tokens.to'),
                  })
                )
              )
            : null)
        )

        const providerChips = providers.length > 0
          ? h('div', { className: 'osta-chiprow', role: 'group', 'aria-label': t('tokens.providerFilter') },
              h('button', {
                type: 'button',
                className: 'osta-tab',
                'aria-pressed': activeProvider === 'all' ? 'true' : 'false',
                onClick: () => requestProvider('all'),
              }, t('tokens.providerAll') + ' · ' + fmtCompact(rangeAllTotal, lang)),
              providers.map((provider) => h('button', {
                key: provider.provider,
                type: 'button',
                className: 'osta-tab',
                title: provider.provider,
                'aria-pressed': activeProvider === provider.provider ? 'true' : 'false',
                onClick: () => requestProvider(provider.provider),
              }, provider.provider + ' · ' + fmtCompact(chipTotalOf(provider.provider), lang)))
            )
          : null

        if (!tokens) {
          return h('section', { className: 'osta-section' },
            h(SectionHead, { icon: h(IconTokens), title: t('tokens.title') }),
            h('div', { className: 'osta-card' }, h('div', { className: 'osta-card-sub' }, t('tokens.unavailable')))
          )
        }

        const scan = tokens.scan || {}
        const scanCandidates = maybeNum(scan.candidates)
        const scanCovered = maybeNum(scan.covered)
        const ignoredState = React.useState(readIgnoredFailedCount())
        const ignoredFailed = ignoredState[0]
        const setIgnoredFailed = ignoredState[1]
        const scanPending = maybeNum(scan.pending)
        const scanFailed = maybeNum(scan.failed)
        const scanRetired = maybeNum(scan.retired)
        const statusChips = []
        if (scanCovered !== null && scanPending !== null && scanPending > 0 && scanCandidates !== null) {
          statusChips.push(h('div', {
            key: 'scanprogress',
            className: 'osta-partial',
            'data-tone': 'info',
            role: 'status',
          }, t('tokens.scanProgress', {
            covered: fmtInt(scanCovered, lang),
            candidates: fmtInt(scanCandidates, lang),
          })))
        }
        if (scanFailed !== null && scanFailed > 0 && scanFailed > ignoredFailed) {
          statusChips.push(h('div', {
            key: 'scanfailed',
            className: 'osta-partial',
            'data-tone': 'info',
            role: 'status',
            title: t('tokens.failedTitle'),
          },
            t('tokens.failed', { n: fmtInt(scanFailed, lang) }),
            h('button', {
              className: 'osta-dismiss',
              type: 'button',
              title: t('tokens.ignoreHint'),
              'aria-label': t('tokens.ignore'),
              onClick: () => {
                writeIgnoredFailedCount(scanFailed)
                setIgnoredFailed(scanFailed)
              },
            }, '×')
          ))
        }
        if (scanRetired !== null && scanRetired > 0) {
          statusChips.push(h('div', {
            key: 'scanretired',
            className: 'osta-partial',
            'data-tone': 'info',
            role: 'status',
            title: t('tokens.retiredTitle'),
          }, t('tokens.retired', { n: fmtInt(scanRetired, lang) })))
        }
        if (scan.partial === true) {
          statusChips.push(h('div', { key: 'scanpartial', className: 'osta-partial', role: 'status' }, t('tokens.partial')))
        }
        return h('section', { className: 'osta-section' },
          h(SectionHead, {
            icon: h(IconTokens),
            title: t('tokens.title'),
            meta: degraded ? null : h('span', null, t('tokens.window', { from: view.lo, to: view.hi })),
          }),
          h('div', { className: 'osta-card-sub' }, t('tokens.subtitle')),
          toolbar,
          providerChips,
          h('div', {
            className: 'osta-card',
            id: 'osta-tabpanel-tokens',
            role: 'tabpanel',
            'aria-labelledby': 'osta-tab-' + tab,
            tabIndex: 0,
          },
            h('div', { className: 'osta-total' },
              h('span', {
                className: 'osta-total-value',
                title: fmtInt(agg.total, lang) + ' ' + t('tokens.total'),
              }, fmtToken(agg.total, lang)),
              h('span', { className: 'osta-total-unit' }, t('tokens.total')),
              h('span', { className: 'osta-total-meta' }, t('tokens.requests') + ' ' + fmtInt(agg.requests, lang))
            ),
            (degraded
              ? h('div', { className: 'osta-partial', 'data-tone': 'info', role: 'status' }, t('tokens.noDaily'))
              : null),
            (isEmpty
              ? h('div', { className: 'osta-empty' },
                  h('div', { className: 'osta-empty-title' }, t('tokens.empty')),
                  h('div', { className: 'osta-empty-sub' }, t('tokens.window', { from: view.lo, to: view.hi }))
                )
              : null),
            h('div', { className: 'osta-metrics' },
              h(Metric, { label: t('tokens.input'), value: fmtToken(agg.input, lang), title: metricTitle(agg.input) }),
              h(Metric, { label: t('tokens.output'), value: fmtToken(agg.output, lang), title: metricTitle(agg.output) }),
              h(Metric, { label: t('tokens.cacheRead'), value: fmtToken(agg.cacheRead, lang), title: metricTitle(agg.cacheRead) }),
              (showOptionalMetric(agg, 'cacheHit')
                ? h(Metric, {
                    label: t('tokens.cacheHit'),
                    value: fmtPct(cacheHitPercent(agg), lang),
                    title: degraded ? degradedHint : t('tokens.cacheHitHint', {
                      hit: fmtInt(agg.cacheRead, lang),
                      input: fmtInt(agg.input, lang),
                    }),
                  })
                : null),
              (showOptionalMetric(agg, 'cacheWrite')
                ? h(Metric, { label: t('tokens.cacheWrite'), value: fmtToken(agg.cacheWrite, lang), title: metricTitle(agg.cacheWrite) })
                : null),
              (showOptionalMetric(agg, 'reasoning')
                ? h(Metric, { label: t('tokens.reasoning'), value: fmtToken(agg.reasoning, lang), title: metricTitle(agg.reasoning) })
                : null),
              h(Metric, { label: t('tokens.requests'), value: fmtInt(agg.requests, lang) }),
              h(Metric, { label: t('tokens.activeDays'), value: fmtInt(agg.activeDays, lang) }),
              h(Metric, {
                label: t('tokens.sessions'),
                value: fmtInt(agg.sessions, lang),
                hint: degraded ? degradedHint : t('tokens.sessionsHint'),
              })
            ),
            (degraded
              ? null
              : h('div', { className: 'osta-card-sub' }, trend.mode === 'hour' ? t('tokens.hourlyTitle') : t('tokens.chartTitle'))),
            (degraded
              ? null
              : h(TrendChart, { trend }))
          ),
          (statusChips.length > 0
            ? h('div', { className: 'osta-status-list' }, statusChips)
            : null),
          h('div', { className: 'osta-footer' },
            h('div', null, t('tokens.footer', { tz: tokens.timeZone || '—' }))
          )
        )
      }

      /**
       * 模型分布（右侧栏）：与左栏 token 统计共用同一套「当前范围 + 所选供应商」口径，
       * 范围 tab / 自定义日期由 StatPage 统一持有并传入。
       */
      function ModelsSection(props) {
        const lang = langOf()
        const tokens = props.tokens
        const tab = typeof props.tab === 'string' && props.tab !== '' ? props.tab : 'today'
        const custom = props.custom !== null && props.custom !== undefined && typeof props.custom === 'object'
          ? props.custom
          : null
        const selectedProvider = typeof props.selectedProvider === 'string' && props.selectedProvider !== ''
          ? props.selectedProvider
          : 'all'
        const bounds = boundsOf(tokens)
        const providers = tokenProviders(tokens)
        let activeProvider = 'all'
        if (selectedProvider !== 'all') {
          for (let i = 0; i < providers.length; i += 1) {
            if (providers[i].provider === selectedProvider) {
              activeProvider = selectedProvider
              break
            }
          }
        }
        const source = selectTokenSource(tokens, activeProvider)
        const defaultFrom = bounds.days.length > 0 ? bounds.days[0].date : bounds.first
        const effectiveFrom = custom && custom.from ? custom.from : defaultFrom
        const effectiveTo = custom && custom.to ? custom.to : bounds.today
        const view = computeSourceRange(source, tab, effectiveFrom, effectiveTo)
        const degraded = view.degraded === true
        const modelRows = modelRangeRows(
          tokens,
          source.providerId,
          degraded ? bounds.first : view.lo,
          degraded ? bounds.today : view.hi
        )
        return h('section', { className: 'osta-section' },
          h('div', { className: 'osta-card' },
            h('div', { className: 'osta-card-title' }, t('tokens.modelsTitle')),
            h(ModelsList, { rows: modelRows, showProvider: source.isAll })
          )
        )
      }

      /* ── C. 官方用量区 ─────────────────────────────────────── */

      function findSourceError(errors, source) {
        if (!Array.isArray(errors)) return null
        for (let i = 0; i < errors.length; i += 1) {
          const entry = errors[i]
          if (entry && entry.source === source) return entry
        }
        return null
      }

      function Sparkline(props) {
        const buckets = Array.isArray(props.buckets) ? props.buckets : []
        // v0.9.3：可选取值字段（默认官方卡用 requestCount；本机 OpenCode 用量传 total）。
        const valueKey = typeof props.valueKey === 'string' && props.valueKey !== '' ? props.valueKey : 'requestCount'
        let max = 0
        buckets.forEach((bucket) => {
          const value = num(bucket[valueKey])
          if (value > max) max = value
        })
        return h('div', { className: 'osta-spark', 'aria-hidden': 'true' },
          buckets.map((bucket, index) => {
            const value = num(bucket[valueKey])
            const height = value <= 0 ? 2 : Math.max(3, Math.round((value / (max > 0 ? max : 1)) * 32))
            return h('div', {
              key: String(index),
              className: 'osta-sparkbar',
              'data-partial': bucket.partial === true ? 'true' : 'false',
              style: { height: height + 'px' },
            })
          })
        )
      }

      function OfficialCard(props) {
        const lang = langOf()
        const data = props.data
        if (!data) {
          return h('article', { className: 'osta-card' },
            h('div', { className: 'osta-card-head' },
              h('div', { className: 'osta-card-main' }, h('div', { className: 'osta-card-title' }, props.title))
            ),
            h('span', { className: 'osta-chip', 'data-tone': 'error' }, t('official.failed')),
            h('div', { className: 'osta-card-sub' },
              props.error ? errText(props.error, t) : t('error.generic'))
          )
        }
        const tokens = data.tokens || null
        const buckets = Array.isArray(data.buckets) ? data.buckets : []
        const inProgress = buckets.some((bucket) => bucket && bucket.partial === true)
        return h('article', { className: 'osta-card' },
          h('div', { className: 'osta-card-head' },
            h('div', { className: 'osta-card-main' }, h('div', { className: 'osta-card-title' }, props.title)),
            inProgress ? h('span', { className: 'osta-chip', 'data-tone': 'warn', title: t('official.inProgress') }, t('official.inProgress')) : null
          ),
          h('div', { className: 'osta-official-head' },
            h('span', { className: 'osta-official-num' }, fmtInt(data.requestCount, lang)),
            h('span', { className: 'osta-total-unit' }, t('official.requests'))
          ),
          h(Sparkline, { buckets }),
          h('div', { className: 'osta-card-sub' },
            t('official.window', { from: fmtUtcShort(data.from), to: fmtUtcShort(data.until) })
          ),
          tokens
            ? h('div', { className: 'osta-mini-grid' },
                h(MiniStat, { label: t('official.input'), value: fmtCompact(tokens.input, lang) }),
                h(MiniStat, { label: t('official.cachedInput'), value: fmtCompact(tokens.cachedInput, lang) }),
                h(MiniStat, { label: t('official.output'), value: fmtCompact(tokens.output, lang) }),
                h(MiniStat, { label: t('official.cost'), value: fmtUsd(tokens.usd, lang) })
              )
            : h('div', { className: 'osta-card-sub' }, t('official.noTokens'))
        )
      }

      function OfficialSection(props) {
        const official = props.official
        const errors = props.errors
        const defs = [
          { key: 'range24h', title: t('official.range24h'), source: 'usage24h' },
          { key: 'range7d', title: t('official.range7d'), source: 'usage7d' },
          { key: 'range30d', title: t('official.range30d'), source: 'usage30d' },
        ]
        if (props.unconfigured === true) {
          // 只配置了 OpenCode Key 时，Ollama 官方请求量不可用；别显示成「获取失败」误导用户。
          return h('section', { className: 'osta-section' },
            h(SectionHead, { icon: h(IconOfficial), title: t('official.title') }),
            h('div', { className: 'osta-card' }, h('div', { className: 'osta-card-sub' }, t('official.noKey')))
          )
        }
        if (!official) {
          return h('section', { className: 'osta-section' },
            h(SectionHead, { icon: h(IconOfficial), title: t('official.title') }),
            h('div', { className: 'osta-card' }, h('div', { className: 'osta-card-sub' }, t('official.empty')))
          )
        }
        return h('section', { className: 'osta-section' },
          h(SectionHead, {
            icon: h(IconOfficial),
            title: t('official.title'),
            meta: h('span', null, t('official.utc')),
          }),
          h('div', { className: 'osta-grid osta-grid-3' },
            defs.map((def) => h(OfficialCard, {
              key: def.key,
              title: def.title,
              data: official[def.key] || null,
              error: findSourceError(errors, def.source),
            }))
          ),
          h('div', { className: 'osta-card-sub' }, t('official.note'))
        )
      }

      /* ── 页脚 / 骨架 / 错误态 ──────────────────────────────── */

      function SnapFooter(props) {
        const snap = props.snap || {}
        const errors = Array.isArray(snap.errors) ? snap.errors : []
        return h('footer', { className: 'osta-footer' },
          errors.length > 0
            ? h('ul', { className: 'osta-errors' },
                errors.map((entry, index) => h('li', { key: String(index), className: 'osta-erroritem' },
                  h('span', { className: 'osta-errorcode' }, String(entry.source || '?')),
                  h('span', null, errText(entry, t))
                ))
              )
            : null,
          h('div', { className: 'osta-version' },
            h('span', null, BUNDLE_ID + ' · v' + PLUGIN_VERSION),
            h('span', null, snap.updatedAt ? t('app.updated', { time: fmtLocal(snap.updatedAt) }) : t('app.autoRefresh'))
          )
        )
      }

      function Skeleton() {
        return h('div', { className: 'osta-skeleton', role: 'status', 'aria-live': 'polite' },
          h('div', { className: 'osta-sk', style: { width: '42%' } }),
          h('div', { className: 'osta-sk-card' }),
          h('div', { className: 'osta-sk-card' })
        )
      }

      function ErrorState(props) {
        return h('div', { className: 'osta-card osta-empty' },
          h('div', { className: 'osta-empty-title' }, t('app.loadFailed')),
          h('div', { className: 'osta-empty-sub' }, errText(props.error, t)),
          h('button', {
            className: 'osta-btn osta-btn-primary',
            type: 'button',
            disabled: props.busy === true,
            'aria-busy': props.busy === true ? 'true' : 'false',
            onClick: props.onRetry,
          }, props.busy === true ? t('app.refreshing') : t('app.retry'))
        )
      }

      /* ── 统计页（数据 owner）────────────────────────────────── */

      function StatPage() {
        const lang = langOf()
        const phaseState = React.useState('loading')
        const phase = phaseState[0]
        const setPhase = phaseState[1]
        const snapState = React.useState(null)
        const snap = snapState[0]
        const setSnap = snapState[1]
        const errorState = React.useState(null)
        const loadError = errorState[0]
        const setLoadError = errorState[1]
        const staleState = React.useState(null)
        const staleError = staleState[0]
        const setStaleError = staleState[1]
        const busyState = React.useState(false)
        const busy = busyState[0]
        const setBusy = busyState[1]
        const keyBusyState = React.useState(false)
        const keyBusy = keyBusyState[0]
        const setKeyBusy = keyBusyState[1]
        const keyValueState = React.useState('')
        const keyValue = keyValueState[0]
        const setKeyValue = keyValueState[1]
        const keyErrorState = React.useState(null)
        const keyError = keyErrorState[0]
        const setKeyError = keyErrorState[1]
        // OpenCode key 独立一套状态：value / busy / error / editing（A 区右侧）。
        const ocKeyBusyState = React.useState(false)
        const ocKeyBusy = ocKeyBusyState[0]
        const setOcKeyBusy = ocKeyBusyState[1]
        const ocKeyValueState = React.useState('')
        const ocKeyValue = ocKeyValueState[0]
        const setOcKeyValue = ocKeyValueState[1]
        const ocKeyErrorState = React.useState(null)
        const ocKeyError = ocKeyErrorState[0]
        const setOcKeyError = ocKeyErrorState[1]
        const ocEditingState = React.useState(false)
        const ocEditing = ocEditingState[0]
        const setOcEditing = ocEditingState[1]
        // v0.9 页头「配置 Key」内联面板。
        const keyPanelState = React.useState(false)
        const keyPanelOpen = keyPanelState[0]
        const setKeyPanelOpen = keyPanelState[1]
        // v0.9.2：provider 显示开关的保存中状态（防重入；两个开关共用）。
        const visBusyState = React.useState(false)
        const visBusy = visBusyState[0]
        const setVisBusy = visBusyState[1]
        // 供应商筛选由页面持有：C 区（Ollama 官方用量）的显隐要跟着它走。
        const providerState = React.useState('all')
        const selectedProvider = providerState[0]
        const setSelectedProvider = providerState[1]
        // 时间范围 tab / 自定义日期也由页面持有：左栏 token 统计与右栏模型分布要共用同一范围。
        const tokenTabState = React.useState('today')
        const tokenTab = tokenTabState[0]
        const setTokenTab = tokenTabState[1]
        const tokenCustomState = React.useState(null)
        const tokenCustom = tokenCustomState[0]
        const setTokenCustom = tokenCustomState[1]
        const tickState = React.useState(0)
        const tick = tickState[0]
        const setTick = tickState[1]
        const snapRef = React.useRef(null)
        const aliveRef = React.useRef(true)
        // SWR 跟进定时器的 dispose（null = 没有待跟进的重采）。
        const followUpRef = React.useRef(null)

        const applySnapshot = (result) => {
          if (!aliveRef.current) return
          if (result !== null && result !== undefined && result.ok === true) {
            const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
            snapRef.current = value
            setSnap(value)
            setLoadError(null)
            setStaleError(null)
            setPhase('ready')
            // SWR 跟进：host 返回 revalidating:true 表示后台正在重采，~10s 后补拉一次——
            // 打开面板先秒开旧数据、几秒后自动换新，不必等满 60s 轮询。同一时刻只挂一个跟进。
            if (value.revalidating === true && followUpRef.current === null) {
              followUpRef.current = later(() => {
                followUpRef.current = null
                if (!aliveRef.current) return
                callRpc('snapshot', {}).then(applySnapshot)
              }, 10000)
            }
            return
          }
          const error = result && result.error && typeof result.error === 'object'
            ? result.error
            : { code: 'internal', message: '' }
          if (snapRef.current === null) {
            if (error.code === 'no-key' || error.code === 'no-data') {
              setPhase('no-key')
              setLoadError(null)
            } else {
              setPhase('error')
              setLoadError(error)
            }
            return
          }
          // 已有数据：保留旧数据，只挂顶部错误条（无 key 时仍留在 ready 视图）。
          setStaleError(error)
        }

        const loadSnapshot = () => {
          callRpc('snapshot', {}).then(applySnapshot)
        }

        const doRefresh = () => {
          if (busy) return
          setBusy(true)
          callRpc('refresh', {}).then((result) => {
            applySnapshot(result)
            if (aliveRef.current) setBusy(false)
          })
        }

        /** 乐观合并 Ollama key（set-key / clear-key 成功后，refresh 被限流也不至于显示旧 key）。 */
        const mergeOllamaKey = (savedKey) => {
          if (!savedKey || typeof savedKey !== 'object' || snapRef.current === null) return
          const merged = Object.assign({}, snapRef.current, { key: savedKey })
          snapRef.current = merged
          setSnap(merged)
        }

        /**
         * 乐观合并 snapshot.opencode.key（旧 host 没有 opencode 字段时新建一个最小对象）。
         * disabledOverride：true/false 时显式改 disabled 标志（enable / set-key 恢复）；
         * 缺省时：解析出真实 key（source !== none）即视为插件级停用已解除。
         */
        const mergeOpencodeKey = (savedKey, disabledOverride) => {
          if (!savedKey || typeof savedKey !== 'object' || snapRef.current === null) return
          const current = snapRef.current
          const prev = current.opencode !== null && current.opencode !== undefined && typeof current.opencode === 'object'
            ? current.opencode
            : {}
          const keySource = typeof savedKey.source === 'string' && savedKey.source !== '' ? savedKey.source : 'manual'
          const next = Object.assign({}, prev, {
            configured: keySource !== 'none',
            key: savedKey,
            kind: typeof prev.kind === 'string' ? prev.kind : 'none',
          })
          if (typeof disabledOverride === 'boolean') next.disabled = disabledOverride
          else if (keySource !== 'none') next.disabled = false
          const merged = Object.assign({}, current, { opencode: next })
          snapRef.current = merged
          setSnap(merged)
        }

        /**
         * v0.9.1：clear-key mode='disable' 成功后乐观把 OpenCode 区整体置为「插件级移除」，
         * A 区 / 本机 CLI 用量 / 侧栏行立即消失，不必等 refresh 回来。
         */
        const mergeOpencodeDisabled = () => {
          if (snapRef.current === null) return
          const merged = Object.assign({}, snapRef.current, {
            opencode: {
              configured: false,
              key: { source: 'none', masked: null },
              disabled: true,
              kind: 'none',
              usage: null,
              local: null,
              note: null,
              fetchedAt: null,
            },
          })
          snapRef.current = merged
          setSnap(merged)
        }

        /**
         * 保存 key：provider 缺省 ollama（契约 §7.2），OpenCode 时额外带 provider:'opencode'。
         * 成功后清空输入框、乐观合并 key、再 refresh 拿真实数据。
         */
        const doSetKey = (provider, token) => {
          const isOpencode = provider === 'opencode'
          const raw = typeof token === 'string' ? token : ''
          const value = raw.trim()
          if (value === '') return
          if (isOpencode ? ocKeyBusy : keyBusy) return
          if (isOpencode) {
            setOcKeyBusy(true)
            setOcKeyError(null)
          } else {
            setKeyBusy(true)
            setKeyError(null)
          }
          callRpc('set-key', { token: value, provider: isOpencode ? 'opencode' : 'ollama' }).then((result) => {
            if (result && result.ok === true) {
              const savedKey = result.value && result.value.key
              if (isOpencode) {
                setOcKeyValue('')
                // v0.9.1：set-key 成功即解除插件级停用（粘贴新 Key 自动恢复）。
                mergeOpencodeKey(savedKey, false)
              } else {
                setKeyValue('')
                mergeOllamaKey(savedKey)
              }
              if (aliveRef.current) setStaleError(null)
              // 保存成功即关闭页头配置面板（A 区的「更换 Key」也走这里，关闭是幂等的）。
              if (aliveRef.current) setKeyPanelOpen(false)
              return callRpc('refresh', {}).then(applySnapshot)
            }
            const error = result && result.error ? result.error : { code: 'internal', message: '' }
            if (aliveRef.current) {
              if (isOpencode) setOcKeyError(error)
              else setKeyError(error)
            }
            return undefined
          }).then(() => {
            if (!aliveRef.current) return
            if (isOpencode) setOcKeyBusy(false)
            else setKeyBusy(false)
          })
        }

        /**
         * 清除 / 停用 key（契约 §8.4）：
         *  - provider 缺省 ollama（mode 仅对 opencode 生效）；
         *  - mode 缺省 / 'manual'：只清插件手动 key（旧行为，可回退到其它来源）；
         *  - mode 'disable'：插件级移除——不再解析/使用任何 OpenCode Key（环境变量 / CLI 登录不删除），
         *    成功后乐观把 opencode 区整体置为 disabled 并 refresh；
         *  - mode 'enable'：清除 disabled 标志、重新 resolve（「恢复外部 Key」）。
         */
        const doClearKey = (provider, mode) => {
          const isOpencode = provider === 'opencode'
          const wantedMode = typeof mode === 'string' ? mode : ''
          const normalizedMode = isOpencode && (wantedMode === 'disable' || wantedMode === 'enable' || wantedMode === 'manual')
            ? wantedMode
            : ''
          if (isOpencode ? ocKeyBusy : keyBusy) return
          if (isOpencode) {
            setOcKeyBusy(true)
            setOcKeyError(null)
          } else {
            setKeyBusy(true)
            setKeyError(null)
          }
          const payload = { provider: isOpencode ? 'opencode' : 'ollama' }
          if (isOpencode && normalizedMode !== '') payload.mode = normalizedMode
          callRpc('clear-key', payload).then((result) => {
            if (result && result.ok === true && isOpencode) {
              if (normalizedMode === 'disable') mergeOpencodeDisabled()
              else if (normalizedMode === 'enable') mergeOpencodeKey(result.value && result.value.key, false)
              else mergeOpencodeKey(result.value && result.value.key)
            }
            return callRpc('refresh', {}).then(applySnapshot)
          }).then(() => {
            if (!aliveRef.current) return
            if (isOpencode) setOcKeyBusy(false)
            else setKeyBusy(false)
          })
        }

        /**
         * v0.9.2：provider 显示开关（set-visibility，不重新采集数据）。
         * 先乐观更新 snap.visibility；成功后用 host 返回的 visibility 归一化覆盖；
         * 失败则回滚并把错误挂到顶部错误条（复用 staleError）。
         */
        const toggleVisibility = (provider) => {
          const isOpencode = provider === 'opencode'
          if (snapRef.current === null || visBusy) return
          const previous = providerVisibility(snapRef.current)
          const next = {
            ollama: isOpencode ? previous.ollama : !previous.ollama,
            opencode: isOpencode ? !previous.opencode : previous.opencode,
          }
          const applyVisibility = (value) => {
            if (snapRef.current === null) return
            const normalized = providerVisibility({ visibility: value })
            const merged = Object.assign({}, snapRef.current, {
              visibility: { ollama: normalized.ollama, opencode: normalized.opencode },
            })
            snapRef.current = merged
            setSnap(merged)
            // 让侧栏横条即时跟随页头开关（否则最多滞后 60s）
            publishVisibility({ ollama: normalized.ollama, opencode: normalized.opencode })
          }
          applyVisibility(next)
          setVisBusy(true)
          callRpc('set-visibility', isOpencode ? { opencode: next.opencode } : { ollama: next.ollama }).then((result) => {
            if (result && result.ok === true) {
              const value = result.value && result.value.visibility
              if (value !== null && value !== undefined && typeof value === 'object') applyVisibility(value)
              if (aliveRef.current) setStaleError(null)
              return
            }
            // 失败回滚：恢复点击前的显示状态，并显示错误条。
            applyVisibility(previous)
            if (aliveRef.current) {
              setStaleError(result && result.error && typeof result.error === 'object'
                ? result.error
                : { code: 'internal', message: '' })
            }
          }).then(() => {
            if (aliveRef.current) setVisBusy(false)
          })
        }

        React.useEffect(() => {
          aliveRef.current = true
          loadSnapshot()
          const dispose = every(() => {
            callRpc('snapshot', {}).then(applySnapshot)
          }, 60000)
          return () => {
            aliveRef.current = false
            dispose()
            if (followUpRef.current !== null) {
              followUpRef.current()
              followUpRef.current = null
            }
          }
        }, [])

        React.useEffect(() => {
          // 30s 重算重置倒计时。
          return every(() => {
            setTick((value) => value + 1)
          }, 30000)
        }, [])

        void tick

        // v0.9：Key 可选——按「哪些 provider 已配置」决定 A 区 / 官方用量 / 页头配置入口的显隐。
        const pageKeys = providerKeyFlags(snap)
        const showConfigButton = snap !== null && pageKeys.showConfig
        // v0.9.2：再叠加用户显示开关（不删除 Key；关闭后该 provider 的 A 区/C 区/侧栏行隐藏）。
        const visibility = providerVisibility(snap)
        const showOllama = pageKeys.hasOllamaKey && visibility.ollama
        const showOpenCode = pageKeys.hasOpenCodeKey && visibility.opencode

        const header = h('header', { className: 'osta-header' },
          h('div', { className: 'osta-header-main' },
            h('h1', { className: 'osta-title' }, t('app.title')),
            h('p', { className: 'osta-sub' }, t('app.subtitle'))
          ),
          h('div', { className: 'osta-header-side' },
            (snap && snap.cached === true)
              ? h('span', { className: 'osta-chip', title: snap.updatedAt ? t('app.updated', { time: fmtLocal(snap.updatedAt) }) : undefined }, t('app.cached'))
              : null,
            (snap && snap.updatedAt)
              ? h('span', { className: 'osta-updated' }, t('app.updated', { time: fmtLocal(snap.updatedAt) }))
              : null,
            // v0.9.2：Ollama / OpenCode 显示开关（aria-pressed；不删除 Key，重新打开立即恢复）。
            snap !== null
              ? h('div', {
                  className: 'osta-toggles',
                  role: 'group',
                  'aria-label': t('visibility.label'),
                  title: t('visibility.hint'),
                },
                  h('button', {
                    className: 'osta-btn osta-btn-sm osta-toggle',
                    type: 'button',
                    'aria-pressed': visibility.ollama ? 'true' : 'false',
                    disabled: visBusy,
                    title: t(visibility.ollama ? 'visibility.toggleOn' : 'visibility.toggleOff', { provider: t('visibility.ollama') }),
                    onClick: () => toggleVisibility('ollama'),
                  },
                    h('span', { className: 'osta-toggle-dot' }),
                    h('span', { className: 'osta-toggle-name' }, t('visibility.ollama'))
                  ),
                  h('button', {
                    className: 'osta-btn osta-btn-sm osta-toggle',
                    type: 'button',
                    'aria-pressed': visibility.opencode ? 'true' : 'false',
                    disabled: visBusy,
                    title: t(visibility.opencode ? 'visibility.toggleOn' : 'visibility.toggleOff', { provider: t('visibility.opencode') }),
                    onClick: () => toggleVisibility('opencode'),
                  },
                    h('span', { className: 'osta-toggle-dot' }),
                    h('span', { className: 'osta-toggle-name' }, t('visibility.opencode'))
                  )
                )
              : null,
            // v0.9：至少一个 provider 未配置时才出现「配置 Key」入口（旧 host no-key 降级页不显示）。
            showConfigButton
              ? h('button', {
                  className: 'osta-btn',
                  type: 'button',
                  'aria-expanded': keyPanelOpen ? 'true' : 'false',
                  'aria-controls': 'osta-key-panel',
                  onClick: () => setKeyPanelOpen(!keyPanelOpen),
                },
                  h(IconKey),
                  h('span', null, t('key.config'))
                )
              : null,
            h('button', {
              className: 'osta-btn',
              type: 'button',
              disabled: busy,
              'aria-busy': busy ? 'true' : 'false',
              onClick: doRefresh,
            },
              h(IconRefresh),
              h('span', null, busy ? t('app.refreshing') : t('app.refresh'))
            )
          )
        )

        let body
        // v0.9：页头「配置 Key」内联面板——只为未配置的 provider 渲染 KeyBar。
        const keyPanel = showConfigButton && keyPanelOpen
          ? h(KeyPanel, {
              key: 'keypanel',
              showOllama: pageKeys.missingOllama,
              showOpencode: pageKeys.missingOpenCode,
              ollamaValue: keyValue,
              ollamaBusy: keyBusy,
              ollamaError: keyError,
              opencodeValue: ocKeyValue,
              opencodeBusy: ocKeyBusy,
              opencodeError: ocKeyError,
              onOllamaChange: setKeyValue,
              onOllamaSubmit: () => doSetKey('ollama', keyValue),
              opencodeDisabled: pageKeys.opencodeDisabled,
              onOpencodeChange: setOcKeyValue,
              onOpencodeSubmit: () => doSetKey('opencode', ocKeyValue),
              onRestoreOpencode: () => doClearKey('opencode', 'enable'),
              onClose: () => setKeyPanelOpen(false),
            })
          : null
        if (snap !== null) {
          const keyInfo = snap.key || { source: 'none', masked: null }
          // C 区（Ollama 官方请求量）只在 Ollama 已配置、显示开关打开、且供应商筛选为 all/ollama 时渲染。
          const showOfficial = showOllama && (selectedProvider === 'all' || selectedProvider === 'ollama')
          // A 区：只渲染「已配置 Key 且显示开关打开」的 provider；两个都显示才左右两栏，
          // 单个单独占满一行，都不显示/没有 Key 时整块不渲染。
          const ollamaSection = showOllama
            ? h(LimitsSection, {
                key: 'limits',
                limits: snap.limits || {},
                tokens: snap.tokens || {},
                keyInfo,
                lang,
                keyValue,
                keyBusy,
                keyError,
                onKeyChange: setKeyValue,
                onKeySubmit: () => doSetKey('ollama', keyValue),
                onClearKey: () => doClearKey('ollama'),
              })
            : null
          const opencodeSection = showOpenCode
            ? h(OpenCodeLimitsSection, {
                key: 'opencode',
                opencode: snap.opencode,
                errors: snap.errors,
                keyValue: ocKeyValue,
                keyBusy: ocKeyBusy,
                keyError: ocKeyError,
                editing: ocEditing,
                onToggleEditing: () => setOcEditing(!ocEditing),
                onKeyChange: setOcKeyValue,
                onKeySubmit: () => doSetKey('opencode', ocKeyValue),
                onClearKey: () => doClearKey('opencode', 'manual'),
                // v0.9.1：插件级移除（任何 Key 来源都可用），成功后乐观隐藏 OpenCode 区。
                onRemoveKey: () => doClearKey('opencode', 'disable'),
              })
            : null
          // v0.9.3：本机 OpenCode 用量只在 local 有可展示数据时渲染（避免 local=null 时留下空 wrapper）。
          const opencodeLocal = snap.opencode !== null && snap.opencode !== undefined && typeof snap.opencode === 'object'
            ? snap.opencode.local
            : null
          const opencodeLocalReady = opencodeLocal !== null && opencodeLocal !== undefined
            && opencodeLocalSummary(opencodeLocal) !== null
          let limitsArea = null
          if (ollamaSection !== null && opencodeSection !== null) {
            limitsArea = h('div', { className: 'osta-limits-pair osta-span' },
              h('div', { className: 'osta-col' }, ollamaSection),
              h('div', { className: 'osta-col' }, opencodeSection)
            )
          } else if (ollamaSection !== null) {
            // 只有 Ollama Key：限额区单独占满一行，不留空的一半。
            limitsArea = h('div', { className: 'osta-col osta-span' }, ollamaSection)
          } else if (opencodeSection !== null) {
            // 只有 OpenCode Key：OpenCode 区（含本机 CLI 用量）占满整行。
            limitsArea = h('div', { className: 'osta-col osta-span' }, opencodeSection)
          }
          body = h('div', { className: 'osta-body' },
            (staleError !== null
              ? h('div', { className: 'osta-errorbar osta-span', role: 'alert' },
                  h(IconAlert),
                  h('span', null, errText(staleError, t))
                )
              : null),
            limitsArea,
            // v0.9.3：本机 OpenCode CLI 用量（全宽三卡，A 区之后 / B 区之前；showOpenCode + local 才渲染）。
            showOpenCode && opencodeLocalReady
              ? h('div', { className: 'osta-span' },
                  h(OpenCodeLocalSection, {
                    key: 'opencode-local',
                    local: opencodeLocal,
                  })
                )
              : null,
            // 左：本机 token 统计；右：模型分布 + Ollama 官方请求量
            //（C 区是 Ollama 账号级数据，切到其它供应商时整块不渲染，此时 token 统计横跨整行）
            h('div', { className: showOfficial ? 'osta-col' : 'osta-col osta-span' },
              h(TokensSection, {
                key: 'tokens',
                tokens: snap.tokens || null,
                lang,
                selectedProvider,
                onSelectProvider: setSelectedProvider,
                tab: tokenTab,
                onTabChange: setTokenTab,
                custom: tokenCustom,
                onCustomChange: setTokenCustom,
              })
            ),
            showOfficial
              ? h('div', { className: 'osta-col' },
                  h(ModelsSection, {
                    key: 'models',
                    tokens: snap.tokens || null,
                    selectedProvider,
                    tab: tokenTab,
                    custom: tokenCustom,
                  }),
                  h(OfficialSection, {
                    key: 'official',
                    official: snap.official || null,
                    errors: snap.errors,
                  })
                )
              : h('div', { className: 'osta-col osta-span' },
                  h(ModelsSection, {
                    key: 'models',
                    tokens: snap.tokens || null,
                    selectedProvider,
                    tab: tokenTab,
                    custom: tokenCustom,
                  })
                ),
            h('div', { className: 'osta-span' }, h(SnapFooter, { key: 'footer', snap }))
          )
        } else if (phase === 'error') {
          body = h(ErrorState, { error: loadError, busy, onRetry: doRefresh })
        } else if (phase === 'no-key') {
          // 两个 Key 都要能配：只有 OpenCode Key 的用户也必须能从这里进入页面
          //（配好 OpenCode Key 后 host 会返回 snapshot，页面自动进入 ready 视图）。
          body = h('div', { className: 'osta-body' },
            h('div', { className: 'osta-limits-pair osta-span' },
              h('div', { className: 'osta-col' },
                h(KeyGuide, {
                  key: 'keyguide',
                  value: keyValue,
                  busy: keyBusy,
                  error: keyError,
                  onChange: setKeyValue,
                  onSubmit: () => doSetKey('ollama', keyValue),
                })
              ),
              h('div', { className: 'osta-col' },
                h(OpenCodeLimitsSection, {
                  key: 'opencode-guide',
                  opencode: null,
                  errors: [],
                  keyValue: ocKeyValue,
                  keyBusy: ocKeyBusy,
                  keyError: ocKeyError,
                  editing: false,
                  onToggleEditing: () => {},
                  onKeyChange: setOcKeyValue,
                  onKeySubmit: () => doSetKey('opencode', ocKeyValue),
                  onClearKey: null,
                })
              )
            )
          )
        } else {
          body = h(Skeleton)
        }

        return h('div', { className: 'osta-page' }, header, keyPanel, body)
      }

      /* ── 侧栏底部双横条 ─────────────────────────────────────── */

      function UsageBars(props) {
        const lang = langOf()
        const snapState = React.useState(null)
        const snap = snapState[0]
        const setSnap = snapState[1]
        const aliveRef = React.useRef(true)
        // 与旧插件一致：只有显式 wide === false（窄栏）才隐藏；隐藏时不轮询。
        const hidden = props !== null && props !== undefined && props.wide === false

        React.useEffect(() => {
          aliveRef.current = true
          if (hidden) {
            return () => {
              aliveRef.current = false
            }
          }
          const load = () => {
            callRpc('snapshot', {}).then((result) => {
              if (!aliveRef.current) return
              if (result && result.ok === true && result.value) setSnap(result.value)
              else setSnap(null)
            })
          }
          load()
          const dispose = every(load, 60000)
          return () => {
            aliveRef.current = false
            dispose()
          }
        }, [hidden])

        // v0.9.2：页头开关的即时广播（不等 60s snapshot 轮询）。
        React.useEffect(() => {
          if (hidden) return undefined
          const listener = (value) => {
            if (!value || typeof value !== 'object') return
            setSnap((previous) => previous !== null && previous !== undefined && typeof previous === 'object'
              ? { ...previous, visibility: { ollama: value.ollama !== false, opencode: value.opencode !== false } }
              : previous)
          }
          visibilityListeners.add(listener)
          return () => {
            visibilityListeners.delete(listener)
          }
        }, [hidden])

        if (hidden) return null

        // v0.9：只为已配置 Key 的 provider 显示横条；全部没有数据时整个组件返回 null
        //（不再显示「Ollama / OpenCode 未配置」占位文案）。
        const barKeys = providerKeyFlags(snap)
        // v0.9.2：显示开关关闭的 provider 不显示横条（但不影响 Key / token 统计）。
        const barVisibility = providerVisibility(snap)
        const showOllamaBar = barKeys.hasOllamaKey && barVisibility.ollama
        const showOpenCodeBar = barKeys.hasOpenCodeKey && barVisibility.opencode
        const limits = snap && snap.limits ? snap.limits : {}
        const session = limits.session || null
        const weekly = limits.weekly || null
        const credits = limits.credits || null
        const rows = []
        if (showOllamaBar && session) {
          rows.push({
            key: 'session',
            label: t('bars.session'),
            percent: maybeNum(session.usedPercent),
            resetsAt: session.resetsAt,
          })
        }
        if (showOllamaBar && weekly) {
          rows.push({
            key: 'weekly',
            label: t('bars.weekly'),
            percent: maybeNum(weekly.usedPercent),
            resetsAt: weekly.resetsAt,
          })
        }
        if (showOllamaBar && rows.length === 0 && limits.kind === 'credits' && credits) {
          const remaining = maybeNum(credits.remainingUsd)
          const allowance = maybeNum(credits.allowanceUsd)
          rows.push({
            key: 'credits',
            label: t('bars.credits'),
            percent: remaining !== null && allowance !== null && allowance > 0
              ? clamp(((allowance - remaining) / allowance) * 100, 0, 100)
              : null,
            resetsAt: null,
          })
        }
        // OpenCode Go 汇总行：追加在 Ollama 行之后；未配置 Key / 无 Go 数据（kind!=='go'）时不出现。
        const opencodeRow = showOpenCodeBar
          ? opencodeBarsRow(snap !== null && snap !== undefined ? snap.opencode : null)
          : null
        if (opencodeRow !== null) {
          rows.push({
            key: 'opencode',
            label: t('bars.opencode'),
            percent: opencodeRow.percent,
            resetsAt: opencodeRow.resetsAt,
            windows: opencodeRow.windows,
          })
        }

        // 没有任何可展示的行（未配置 Key / 无 Go 数据）→ 整个组件返回 null。
        if (rows.length === 0) return null

        const updatedAt = snap && snap.updatedAt ? fmtLocal(snap.updatedAt) : null
        const segments = rows.map((row) => {
          // OpenCode 行：title 列出 rolling/weekly/monthly 的百分比与重置倒计时。
          if (Array.isArray(row.windows)) {
            const detail = row.windows.map((win) => {
              const winReset = countdownText(t, win.resetsAt)
              return t(win.shortKey) + ' ' + fmtPct(win.usedPercent, lang) + (winReset === null ? '' : ' · ' + winReset)
            }).join(' · ')
            return row.label + ' ' + fmtPct(row.percent, lang) + t('bars.opencodeDetail', { windows: detail })
          }
          const reset = countdownText(t, row.resetsAt)
          return row.label + ' ' + fmtPct(row.percent, lang) + (reset === null ? '' : t('bars.resetSuffix', { time: reset }))
        })
        const tip = t('bars.tipLead') + ' · ' + segments.join(' · ') + (updatedAt === null ? '' : ' · ' + t('bars.updated', { time: updatedAt }))

        return h('div', { className: 'osta-bars', title: tip, role: 'group', 'aria-label': t('bars.label') },
          rows.map((row) => {
            const tone = toneOf(row.percent)
            const fill = toneFill(row.percent)
            const width = row.percent === null || row.percent <= 0 ? 0 : Math.max(row.percent, 2)
            return h('div', {
              key: row.key,
              className: 'osta-barsrow',
              'data-tone': tone === 'warn' || tone === 'error' ? tone : undefined,
            },
              h('div', { className: 'osta-barshead' },
                h('span', { className: 'osta-barslabel' },
                  h('span', { className: 'osta-barsdot', style: { '--osta-fill': fill } }),
                  row.label
                ),
                h('span', { className: 'osta-barsval' }, fmtPct(row.percent, lang))
              ),
              h('div', {
                className: 'osta-minibar',
                role: 'progressbar',
                'aria-label': t('limits.used') + ' ' + row.label,
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-valuenow': row.percent === null ? 0 : Math.round(row.percent),
              },
                h('div', {
                  className: 'osta-minibarfill',
                  style: { width: clamp(width, 0, 100) + '%', '--osta-fill': fill },
                })
              )
            )
          })
        )
      }

      /* ── 槽位注册（三处）────────────────────────────────────── */

      // 1) 侧栏面板入口：原创 SVG 图标（props.size / props.active）。
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: 'ollama-statistical',
        order: 30,
        label: () => t('panel.label'),
      }, PanelIcon))

      // 2) 主内容区统计页（key 与 panellist id 一致）。
      slots.inject('main', () => slots.register({
        name: 'main',
        key: 'ollama-statistical',
      }, StatPage))

      // 3) 侧栏底部常驻双横条（props.wide === false 时自行返回 null）。
      slots.inject('sidebar.footer.action', () => slots.register({
        name: 'sidebar.footer.action',
        id: 'ollama-statistical-bars',
        // order 用大值：宿主 footer 动作区里还有 cordis-panel / wsl-workspace 等插件图标，
        // 双横条要排在它们之后 —— 配合 CSS 的 flex-wrap 独占最后一行，紧贴 Settings 之上。
        order: 100,
        label: () => t('bars.label'),
      }, UsageBars))
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection', 'timer', 'locale']

    /**
     * 纯函数测试口（供 test/client-logic.test.mjs 用 node:vm 加载后断言）。
     * 只暴露无副作用的推导/格式化函数与内置字典，不暴露组件与服务实例。
     */
    exports.__test = {
      // 范围切片（B 区 tab / 自定义日期）
      computeRange,
      computeSourceRange,
      boundsOf,
      dayList,
      // 供应商数据源选择 / 范围口径分布行（全部供应商视图）
      tokenProviders,
      providerDaysOf,
      selectTokenSource,
      buildProviderRows,
      providerRangeTotal,
      providerRangeRows,
      modelRangeRows,
      // 柱状图粒度（今天→小时桶，其它→天）+ 小时桶校验
      chartSeries,
      chartTrend,
      normalizeHourBuckets,
      // i18n（语言判定 / 占位符插值 / 字典）
      detectLang,
      defaultDictFor: fallbackDict,
      interpolate,
      DICT_ZH,
      DICT_EN,
      // 数字 / 时间 / 百分比格式化
      fmtNum,
      fmtPct,
      fmtInt,
      fmtCompact,
      fmtToken,
      fmtUsd,
      fmtLocal,
      fmtUtcShort,
      countdownText,
      // v0.9：Key 是否已配置（A 区 / 官方用量 / 侧栏行 / 配置入口的显隐依据）
      providerKeyFlags,
      // v0.9.2：provider 显示开关（A 区 / 官方用量 / 侧栏行的显隐过滤）
      providerVisibility,
      // v0.9.4：OpenCode 额度卡 token 估算（rolling/weekly/monthly usedTokens）
      opencodeQuotaEstimates,
      // OpenCode Go（v0.8）：snapshot.opencode 归一化 / 三窗口行 / 侧栏汇总行 / 本机 CLI 汇总
      opencodeState,
      opencodeWindowRows,
      opencodeBarsRow,
      opencodeLocalSummary,
      // 阈值与数值工具
      toneOf,
      toneColor,
      toneFill,
      estimateQuotaTokens,
      readIgnoredFailedCount,
      writeIgnoredFailedCount,
      clamp,
      num,
      maybeNum,
      cacheHitPercent,
      showOptionalMetric,
    }

    return module.exports
  },
})
