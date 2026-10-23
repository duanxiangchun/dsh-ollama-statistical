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
    const PLUGIN_VERSION = '0.4.2'

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
      '.osta-page{display:flex;flex-direction:column;gap:16px;height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:20px 24px 32px;width:100%;max-width:none;margin:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}',
      '.osta-page *{box-sizing:border-box}',
      '.osta-body{display:flex;flex-direction:column;gap:16px;min-width:0}',
      '.osta-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;min-width:0;flex-wrap:wrap}',
      '.osta-header-main{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.osta-title{margin:0;font:var(--dsw-font-s-14);font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:-.005em}',
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
      '.osta-section{display:flex;flex-direction:column;gap:12px;min-width:0}',
      '.osta-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;flex-wrap:wrap}',
      '.osta-section-title{display:inline-flex;align-items:center;gap:8px;font:var(--dsw-font-xxs-strong-12);font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;min-width:0}',
      '.osta-section-icon{display:block;flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.osta-section-meta{display:inline-flex;align-items:center;gap:6px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);min-width:0;flex-wrap:wrap}',
      '.osta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;min-width:0}',
      '.osta-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}',
      '.osta-card{display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.osta-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}',
      '.osta-card-main{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.osta-card-title{font:var(--dsw-font-xxs-strong-12);font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.osta-card-sub{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:16px}',

      // ── 限额卡 ────────────────────────────────────────────────
      '.osta-limit-values{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;min-width:0}',
      '.osta-limit-primary{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.osta-bignum{font-size:26px;line-height:1.05;font-weight:640;font-variant-numeric:tabular-nums;letter-spacing:-.015em;color:var(--dsw-alias-label-primary)}',
      '.osta-bigpct{font-size:14px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-left:1px}',
      '.osta-limlabel{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.osta-limsecondary{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.osta-track{height:8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,var(--dsw-alias-bg-layer-2));overflow:hidden}',
      '.osta-track-sm{height:5px}',
      '.osta-fill{height:100%;border-radius:999px;transition:width .25s ease,background-color .2s ease}',
      '.osta-note{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);min-width:0}',
      '.osta-note-item{font-variant-numeric:tabular-nums;min-width:0}',

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
      '.osta-total-value{font-size:32px;line-height:1;font-weight:660;font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--dsw-alias-label-primary)}',
      '.osta-total-unit{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.osta-total-meta{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.osta-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;min-width:0}',
      '.osta-metric{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);min-width:0}',
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
      '.osta-trend-legend{display:flex;align-items:center;justify-content:center;gap:4px 14px;flex-wrap:wrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);min-width:0}',
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
      '.osta-models{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.osta-model{display:flex;flex-direction:column;gap:4px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}',
      '.osta-model:last-child{border-bottom:none}',
      '.osta-model-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}',
      '.osta-model-title{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto}',
      '.osta-model-name{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 auto}',
      '.osta-model-provider{flex:none;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.osta-model-meta{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.osta-model-value{font:var(--dsw-font-xxs-strong-12);font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.osta-model-track{height:4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);overflow:hidden}',
      '.osta-model-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#93c5fd,#4f8ff7)}',
      '.osta-providerrow{display:flex;flex-direction:column;gap:4px;width:100%;padding:7px 0;border:none;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;text-align:left;cursor:pointer;color:inherit;font:inherit;min-width:0}',
      '.osta-providerrow:last-child{border-bottom:none}',
      '.osta-providerrow:hover .osta-model-name{color:var(--dsw-alias-label-primary)}',
      '.osta-providerrow:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',

      // ── 官方用量 ──────────────────────────────────────────────
      '.osta-spark{display:flex;align-items:flex-end;gap:2px;height:36px;width:100%;min-width:0}',
      '.osta-sparkbar{flex:1 1 0;min-width:1px;min-height:2px;border-radius:1px;background:linear-gradient(180deg,#67e8f9,#17b4c8)}',
      '.osta-sparkbar[data-partial=true]{background:#0d9488}',
      '.osta-official-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}',
      '.osta-official-num{font-size:26px;line-height:1.05;font-weight:640;font-variant-numeric:tabular-nums;letter-spacing:-.015em}',
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
      '.osta-footer{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);line-height:16px;min-width:0}',
      '.osta-errors{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none;min-width:0}',
      '.osta-erroritem{display:flex;align-items:baseline;gap:6px;min-width:0;word-break:break-word}',
      '.osta-errorcode{font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-state-error-primary);flex:none;font-variant-numeric:tabular-nums}',
      '.osta-partial{display:inline-flex;align-items:center;align-self:flex-start;gap:6px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary);font:var(--dsw-font-xxxs-strong-11);font-weight:500}',
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
      'panel.label': 'Ollama 统计',

      'app.title': 'Ollama 用量统计',
      'app.subtitle': '限额 · 本机 token 统计 · 官方请求量',
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
      'tokens.byProvider': '按供应商分布',
      'tokens.providerRequests': '{n} 次请求',
      'tokens.providerTotalsHint': '该供应商缺少逐日明细，以下为近 30 天窗口合计',
      'tokens.windowValueSuffix': '（窗口值）',
      'tokens.noDaily': '该供应商没有逐日明细，以下只显示近 30 天窗口合计',
      'tokens.partial': '扫描未完成，数据可能不完整（可点刷新）',
      'tokens.scanProgress': '正在补齐历史会话 {covered}/{candidates}（后台继续扫描，刷新即可看到更多）',
      'tokens.failed': '{n} 个会话日志读取失败，暂未计入',
      'tokens.failedTitle': '这些会话日志读取失败（可能是旧格式或日志损坏），在 DSH 里打开一次对应会话可触发迁移；插件每 6 小时会重试。',
      'tokens.retired': '含 {n} 个已删除会话',
      'tokens.retiredTitle': '这些会话已从 DSH 删除，但插件保留了它们的 token 统计（账本：$DSH_HOME/storages/ollama-statistical/ledger.json，删除该文件可清空）',
      'tokens.unavailable': '未能读取本机会话日志，token 统计不可用',
      'tokens.footer': '数据来源：本机 DSH 会话日志（全部供应商） · 时区 {tz} · 官方接口对 legacy 套餐不返回 token 数',

      'official.title': 'Ollama 官方请求量',
      'official.range24h': '近 24 小时',
      'official.range7d': '近 7 天',
      'official.range30d': '近 30 天',
      'official.requests': '次请求',
      'official.input': '输入 token',
      'official.cachedInput': '缓存命中',
      'official.output': '输出 token',
      'official.cost': '费用',
      'official.failed': '获取失败',
      'official.empty': '官方用量数据不可用',
      'official.note': '官方口径：UTC 小时 / 日；legacy 套餐仅返回请求次数；含该账号所有客户端，不限于本 Key。',
      'official.utc': 'UTC 口径',
      'official.inProgress': '当前小时/当日进行中',
      'official.noTokens': '该套餐未返回 token 明细',
      'official.window': '{from} — {to}（UTC）',

      'bars.label': 'Ollama 统计',
      'bars.session': '会话 5h',
      'bars.weekly': '本周',
      'bars.credits': '订阅额度',
      'bars.unconfigured': 'Ollama 未配置',
      'bars.resetSuffix': '（{time}后重置）',
      'bars.updated': '更新于 {time}',
      'bars.tipLead': 'Ollama 统计',
      'bars.tipEmpty': 'Ollama 统计：未配置 API Key，打开「Ollama 统计」页完成配置',

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
      'panel.label': 'Ollama Stats',

      'app.title': 'Ollama usage',
      'app.subtitle': 'Limits · local token stats · official requests',
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
      'tokens.byProvider': 'By provider',
      'tokens.providerRequests': '{n} requests',
      'tokens.providerTotalsHint': 'No daily breakdown for this provider; the 30-day window totals are shown below',
      'tokens.windowValueSuffix': ' (window value)',
      'tokens.noDaily': 'No daily breakdown for this provider; only the 30-day window totals are shown',
      'tokens.partial': 'Scan incomplete — numbers may be understated (press Refresh)',
      'tokens.scanProgress': 'Backfilling history {covered}/{candidates} (scanning in background; refresh to see more)',
      'tokens.failed': '{n} sessions could not be read (not counted yet)',
      'tokens.failedTitle': 'These session logs failed to read (old format or corrupted). Open each session once in DSH to trigger migration; the plugin retries every 6 hours.',
      'tokens.retired': 'includes {n} deleted sessions',
      'tokens.retiredTitle': 'These sessions were deleted from DSH, but their token usage is kept in the plugin ledger ($DSH_HOME/storages/ollama-statistical/ledger.json; delete the file to clear it).',
      'tokens.unavailable': 'Could not read the local session log; token stats are unavailable',
      'tokens.footer': 'Source: local DSH session log (all providers) · time zone {tz} · the official API returns no token counts for legacy plans',

      'official.title': 'Ollama official request counts',
      'official.range24h': 'Last 24 hours',
      'official.range7d': 'Last 7 days',
      'official.range30d': 'Last 30 days',
      'official.requests': 'requests',
      'official.input': 'Input tokens',
      'official.cachedInput': 'Cache hits',
      'official.output': 'Output tokens',
      'official.cost': 'Cost',
      'official.failed': 'Fetch failed',
      'official.empty': 'Official usage is unavailable',
      'official.note': 'Official basis: UTC hours / days; legacy plans return request counts only; covers every client on this account, not just this key.',
      'official.utc': 'UTC basis',
      'official.inProgress': 'Current hour/day in progress',
      'official.noTokens': 'This plan returned no token breakdown',
      'official.window': '{from} — {to} (UTC)',

      'bars.label': 'Ollama Stats',
      'bars.session': 'Session 5h',
      'bars.weekly': 'Week',
      'bars.credits': 'Credit',
      'bars.unconfigured': 'Ollama not configured',
      'bars.resetSuffix': ' (resets in {time})',
      'bars.updated': 'updated {time}',
      'bars.tipLead': 'Ollama stats',
      'bars.tipEmpty': 'Ollama stats: no API key — open the Ollama Stats page to configure one',

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
        const resetIn = countdownText(t, data.resetsAt)
        return h('article', { className: 'osta-card' },
          h('div', { className: 'osta-card-head' },
            h('div', { className: 'osta-card-main' },
              h('div', { className: 'osta-card-title', title: props.title }, props.title),
              props.note ? h('div', { className: 'osta-card-sub' }, props.note) : null
            ),
            h('span', { className: 'osta-chip', 'data-tone': tone }, t('limits.tone.' + tone))
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
            h('div', { className: 'osta-fill', style: { width: width + '%', background: toneColor(used) } })
          ),
          h('div', { className: 'osta-note' },
            h('span', { className: 'osta-note-item' }, resetIn === null ? t('limits.resetUnknown') : t('limits.resetIn', { time: resetIn })),
            data.resetsAt ? h('span', { className: 'osta-note-item', title: String(data.resetsAt) }, t('limits.resetAt', { time: fmtLocal(data.resetsAt) })) : null
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

      function KeyForm(props) {
        return h('form', {
          className: 'osta-keyform',
          onSubmit: (event) => {
            event.preventDefault()
            props.onSubmit()
          },
        },
          h('label', { className: 'osta-sr', htmlFor: 'osta-key-input' }, t('key.label')),
          h('input', {
            id: 'osta-key-input',
            className: 'osta-input osta-input-wide',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: t('key.placeholder'),
            value: props.value,
            disabled: props.busy === true,
            onChange: (event) => props.onChange(event.target.value),
          }),
          h('button', {
            className: 'osta-btn osta-btn-primary',
            type: 'submit',
            disabled: props.busy === true || props.value.trim() === '',
            'aria-busy': props.busy === true ? 'true' : 'false',
          }, props.busy === true ? t('key.submitting') : t('key.submit'))
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
        return h('div', { className: 'osta-keybar' },
          h('div', { className: 'osta-keybar-head' },
            h(IconKey),
            h('div', { className: 'osta-keybar-text' },
              h('div', { className: 'osta-keybar-title' }, t('key.barTitle')),
              h('div', { className: 'osta-keybar-sub' }, t('key.barSub'))
            )
          ),
          h(KeyForm, { value: props.value, busy: props.busy, onChange: props.onChange, onSubmit: props.onSubmit }),
          props.error ? h('div', { className: 'osta-error', role: 'alert' }, errText(props.error, t)) : null
        )
      }

      function LimitsSection(props) {
        const lang = langOf()
        const limits = props.limits || {}
        const keyInfo = props.keyInfo || {}
        const noKey = !keyInfo.source || keyInfo.source === 'none'
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
            cards.push(h(LimitCard, { key: 'weekly', title: t('limits.weekly'), data: weekly, note: t('limits.weekNote') }))
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
          noKey
            ? h(KeyBar, {
                value: props.keyValue,
                busy: props.keyBusy,
                error: props.keyError,
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
        const H = 260
        const PL = 62
        const PR = 56
        const PT = 14
        const PB = 28
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
        const rows = Array.isArray(props.rows) ? props.rows : []
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
              ? t('tokens.windowValueSuffix')
              : ' · ' + fmtPct(row.share, lang)
            return h('div', { key: String(row.model || index) + ':' + (provider || '') + (row.degraded === true ? ':window' : ''), className: 'osta-model' },
              h('div', { className: 'osta-model-head' },
                h('span', { className: 'osta-model-title' },
                  provider === null ? null : h('span', { className: 'osta-model-provider', title: provider }, provider),
                  h('span', { className: 'osta-model-name', title: String(row.model || '') }, name)
                ),
                h('span', {
                  className: 'osta-model-value',
                  title: fmtInt(row.total, lang) + ' ' + t('tokens.total') + suffix,
                }, fmtCompact(row.total, lang) + suffix)
              ),
              h('div', { className: 'osta-model-track' },
                h('div', {
                  className: 'osta-model-fill',
                  style: {
                    width: clamp(row.share === null ? 0 : row.share, 0, 100) + '%',
                    background: VIZ_PALETTE[index % VIZ_PALETTE.length],
                  },
                })
              )
            )
          })
        )
      }

      function TokensSection(props) {
        const lang = langOf()
        const tokens = props.tokens
        const tabState = React.useState('today')
        const tab = tabState[0]
        const setTab = tabState[1]
        const customState = React.useState(null)
        const custom = customState[0]
        const setCustom = customState[1]
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
        // 模型榜同样按当前视图范围求和；degraded 视图（该供应商无逐日桶）用整窗口回退。
        const modelRows = modelRangeRows(
          tokens,
          source.providerId,
          degraded ? bounds.first : view.lo,
          degraded ? bounds.today : view.hi
        )
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
        if (scanFailed !== null && scanFailed > 0) {
          statusChips.push(h('div', {
            key: 'scanfailed',
            className: 'osta-partial',
            'data-tone': 'info',
            role: 'status',
            title: t('tokens.failedTitle'),
          }, t('tokens.failed', { n: fmtInt(scanFailed, lang) })))
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
            (source.isAll && rangeRows.length > 0
              ? h('div', { className: 'osta-models' },
                  h('div', { className: 'osta-card-sub' }, t('tokens.byProvider')),
                  (rangeAllTotal > 0
                    ? rangeRows.map((row, rowIndex) => h('button', {
                        key: row.provider,
                        type: 'button',
                        className: 'osta-providerrow',
                        title: t('tokens.providerFilter') + ': ' + row.provider,
                        onClick: () => requestProvider(row.provider),
                      },
                        h('div', { className: 'osta-model-head' },
                          h('span', { className: 'osta-model-title' },
                            h('span', { className: 'osta-model-name' }, row.provider),
                            h('span', { className: 'osta-model-meta' }, t('tokens.providerRequests', { n: fmtInt(row.requests, lang) }))
                          ),
                          h('span', { className: 'osta-model-value' }, fmtCompact(row.total, lang) + ' · ' + fmtPct(row.share, lang))
                        ),
                        h('div', { className: 'osta-model-track' },
                          h('div', {
                            className: 'osta-model-fill',
                            style: {
                              width: clamp(row.share === null ? 0 : row.share, 0, 100) + '%',
                              background: VIZ_PALETTE[rowIndex % VIZ_PALETTE.length],
                            },
                          })
                        )
                      ))
                    : h('div', { className: 'osta-card-sub' }, t('tokens.empty')))
                )
              : null),
            (degraded
              ? null
              : h('div', { className: 'osta-card-sub' }, trend.mode === 'hour' ? t('tokens.hourlyTitle') : t('tokens.chartTitle'))),
            (degraded
              ? null
              : h(TrendChart, { trend }))
          ),
          h('div', { className: 'osta-card' },
            h('div', { className: 'osta-card-title' }, t('tokens.modelsTitle')),
            h(ModelsList, { rows: modelRows, showProvider: source.isAll })
          ),
          (statusChips.length > 0
            ? h('div', { className: 'osta-status-list' }, statusChips)
            : null),
          h('div', { className: 'osta-footer' },
            h('div', null, t('tokens.footer', { tz: tokens.timeZone || '—' }))
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
        let max = 0
        buckets.forEach((bucket) => {
          const value = num(bucket.requestCount)
          if (value > max) max = value
        })
        return h('div', { className: 'osta-spark', 'aria-hidden': 'true' },
          buckets.map((bucket, index) => {
            const value = num(bucket.requestCount)
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
        // 供应商筛选由页面持有：C 区（Ollama 官方用量）的显隐要跟着它走。
        const providerState = React.useState('all')
        const selectedProvider = providerState[0]
        const setSelectedProvider = providerState[1]
        const tickState = React.useState(0)
        const tick = tickState[0]
        const setTick = tickState[1]
        const snapRef = React.useRef(null)
        const aliveRef = React.useRef(true)

        const applySnapshot = (result) => {
          if (!aliveRef.current) return
          if (result !== null && result !== undefined && result.ok === true) {
            const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
            snapRef.current = value
            setSnap(value)
            setLoadError(null)
            setStaleError(null)
            setPhase('ready')
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

        const doSetKey = () => {
          const token = keyValue.trim()
          if (token === '' || keyBusy) return
          setKeyBusy(true)
          setKeyError(null)
          callRpc('set-key', { token }).then((result) => {
            if (result && result.ok === true) {
              setKeyValue('')
              // 乐观合并 key 状态：即使随后的 refresh 被 60s 限流挡下，界面也已显示新 key。
              const savedKey = result.value && result.value.key
              if (savedKey && snapRef.current !== null) {
                const merged = Object.assign({}, snapRef.current, { key: savedKey })
                snapRef.current = merged
                setSnap(merged)
              }
              if (aliveRef.current) setStaleError(null)
              return callRpc('refresh', {}).then(applySnapshot)
            }
            if (aliveRef.current) setKeyError(result && result.error ? result.error : { code: 'internal', message: '' })
            return undefined
          }).then(() => {
            if (aliveRef.current) setKeyBusy(false)
          })
        }

        const doClearKey = () => {
          if (keyBusy) return
          setKeyBusy(true)
          setKeyError(null)
          callRpc('clear-key', {}).then(() => callRpc('refresh', {}).then(applySnapshot)).then(() => {
            if (aliveRef.current) setKeyBusy(false)
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
          }
        }, [])

        React.useEffect(() => {
          // 30s 重算重置倒计时。
          return every(() => {
            setTick((value) => value + 1)
          }, 30000)
        }, [])

        void tick

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
        if (snap !== null) {
          const keyInfo = snap.key || { source: 'none', masked: null }
          body = h('div', { className: 'osta-body' },
            (staleError !== null
              ? h('div', { className: 'osta-errorbar', role: 'alert' },
                  h(IconAlert),
                  h('span', null, errText(staleError, t))
                )
              : null),
            h(LimitsSection, {
              key: 'limits',
              limits: snap.limits || {},
              keyInfo,
              lang,
              keyValue,
              keyBusy,
              keyError,
              onKeyChange: setKeyValue,
              onKeySubmit: doSetKey,
              onClearKey: doClearKey,
            }),
            h(TokensSection, {
              key: 'tokens',
              tokens: snap.tokens || null,
              lang,
              selectedProvider,
              onSelectProvider: setSelectedProvider,
            }),
            // C 区是 Ollama 账号级数据：只在「全部」或选中 ollama 时显示；
            // 切到 wb / sub / mgdaas / new-api 等其它供应商时整块不渲染（A 区仍保留）。
            (selectedProvider === 'all' || selectedProvider === 'ollama')
              ? h(OfficialSection, { key: 'official', official: snap.official || null, errors: snap.errors })
              : null,
            h(SnapFooter, { key: 'footer', snap })
          )
        } else if (phase === 'error') {
          body = h(ErrorState, { error: loadError, busy, onRetry: doRefresh })
        } else if (phase === 'no-key') {
          body = h('div', { className: 'osta-body' },
            h(KeyGuide, { value: keyValue, busy: keyBusy, error: keyError, onChange: setKeyValue, onSubmit: doSetKey })
          )
        } else {
          body = h(Skeleton)
        }

        return h('div', { className: 'osta-page' }, header, body)
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

        if (hidden) return null

        const limits = snap && snap.limits ? snap.limits : {}
        const session = limits.session || null
        const weekly = limits.weekly || null
        const credits = limits.credits || null
        const rows = []
        if (session) {
          rows.push({
            key: 'session',
            label: t('bars.session'),
            percent: maybeNum(session.usedPercent),
            resetsAt: session.resetsAt,
          })
        }
        if (weekly) {
          rows.push({
            key: 'weekly',
            label: t('bars.weekly'),
            percent: maybeNum(weekly.usedPercent),
            resetsAt: weekly.resetsAt,
          })
        }
        if (rows.length === 0 && limits.kind === 'credits' && credits) {
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

        const updatedAt = snap && snap.updatedAt ? fmtLocal(snap.updatedAt) : null
        let tip
        if (rows.length === 0) {
          tip = t('bars.tipEmpty')
        } else {
          const segments = rows.map((row) => {
            const reset = countdownText(t, row.resetsAt)
            return row.label + ' ' + fmtPct(row.percent, lang) + (reset === null ? '' : t('bars.resetSuffix', { time: reset }))
          })
          tip = t('bars.tipLead') + ' · ' + segments.join(' · ') + (updatedAt === null ? '' : ' · ' + t('bars.updated', { time: updatedAt }))
        }

        if (rows.length === 0) {
          return h('div', { className: 'osta-bars', title: tip, role: 'group', 'aria-label': t('bars.label') },
            h('span', { className: 'osta-barsempty' }, t('bars.unconfigured'))
          )
        }

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
      // 阈值与数值工具
      toneOf,
      toneColor,
      toneFill,
      clamp,
      num,
      maybeNum,
      cacheHitPercent,
      showOptionalMetric,
    }

    return module.exports
  },
})
