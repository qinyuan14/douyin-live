---
name: 猫掌柜 AI 实景直播经营系统
description: 把真实洗护现场、风险门禁与经营闭环组织成一块可信的值班板
colors:
  ink: "#17222d"
  workshop-navy: "#152838"
  wash-paper: "#fbfaf6"
  work-surface: "#eef1f4"
  steel-line: "#c8d0d6"
  inspection-blue: "#176b87"
  inspection-blue-deep: "#0d5068"
  safety-amber: "#be7111"
  qualified-green: "#2c7658"
  stop-red: "#a63e34"
typography:
  headline:
    fontFamily: "Microsoft YaHei UI, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Microsoft YaHei UI, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "Microsoft YaHei UI, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Microsoft YaHei UI, Segoe UI, sans-serif"
    fontSize: "10px"
    fontWeight: 700
rounded:
  control: "12px"
  panel: "14px"
  surface: "16px"
spacing:
  compact: "8px"
  control: "12px"
  panel: "20px"
  workspace: "32px"
components:
  button-primary:
    backgroundColor: "{colors.inspection-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    height: "42px"
    padding: "0 15px"
  button-secondary:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "42px"
    padding: "0 15px"
  panel:
    backgroundColor: "#fbfcfb"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "22px"
---

# Design System: 猫掌柜 AI 实景直播经营系统

## Overview

**Creative North Star: “洗护工坊值班板”**

界面像真实洗护车间里一块正在工作的值班板：员工先看到今晚状态、设备和风险，再进入主持、问答与经营记录。品牌性格来自精确工单、检验状态和黑猫掌柜小标识，不依赖数字人、营销大屏或装饰性特效。

它以高扫描效率为第一原则。控制台偏明亮、清楚和克制；直播输出则以深色实景底承托高对比字幕，让抖音画面被截取时仍能辨认AI主持、商品证据状态和人工处理边界。

**Key Characteristics:**

- 实景画面始终比数据和装饰占据更大空间。
- 合格、待确认、阻断和直播状态同时使用图标、文字与颜色。
- 价格、利润和权限的未知状态必须直接写出，不以空白或零替代。
- 黑猫标识只承担品牌识别，不变成遮挡现场的卡通主持人。

## Colors

受洗护工坊、检验工单和不锈钢设备启发的冷中性色，配合少量功能色。

### Primary

- **检验蓝**：主要按钮、当前任务和信息图标，表达可执行但不代表平台授权。
- **工坊墨蓝**：侧边导航和直播输出底色，建立稳定的工作环境。

### Secondary

- **安全琥珀**：需要员工确认、设备待验证和注意事项。
- **合格绿**：真实通过的证据、设备与经营检查。
- **停机红**：试播阻断、禁止播报和安全停止。

### Neutral

- **洗护纸白**：工单、话术纸和直播字幕的高可读表面。
- **工作台灰**：应用背景与摄像头安全取景区域。
- **钢线灰**：分隔、输入边框和低层级轮廓。
- **墨色文字**：正文与重要数字。

**The Evidence Color Rule.** 绿、黄、红只表达已经由系统确定的状态，不作为装饰，也不把“待确认”染成“已通过”。

## Typography

全系统使用 Windows 原生中文无衬线工作字体，保证本地离线、Electron 与抖音直播伴侣环境中的稳定显示。

### Hierarchy

- **Headline**：24px、700，用于当前工作页面标题。
- **Shift time**：30px、700，用于今晚班次时间，是首页最大文字。
- **Title**：16–18px、700，用于面板和当前任务。
- **Body**：12–13px、400–600，用于说明、答案和工单内容。
- **Label**：9–11px、700，用于状态、证据和辅助数据。
- **Broadcast caption**：按9:16画布宽度约4.3%缩放、800，用于直播字幕。

**The One-Read Rule.** 员工站在洗护台旁时，状态、主操作和停止原因必须一眼读完，不能依赖悬停或二级解释。

## Layout

桌面控制台使用226px侧栏与弹性工作区；1180px以下折叠为80px图标栏。工作区标题栏固定清晰，主页面优先使用“主任务 + 右侧安全轨道”，业务结果位于同屏底部。900px以下所有主要双栏变为单列，表格与流程表允许内部滚动。

9:16直播输出独立成窗，真实摄像画面填满画布；AI标识位于顶部安全区，字幕与商品快照位于底部安全区。字幕和商品不进入画面中央，不遮挡洗护动作。

## Elevation & Depth

大部分深度由不同纸面、工作台灰和钢线边界形成。只有主值班板、脚本纸和字幕使用低透明度环境阴影，表示当前工作层级；状态行、按钮和表格保持平面。

- **主值班板**：柔和向下扩散阴影，用于首页唯一主任务面板。
- **脚本纸**：轻微纸面阴影，让主持文本与操作控件分离。
- **直播字幕**：较深环境阴影，确保叠加在真实画面上仍可读。

**The Flat State Rule.** 状态本身靠图标、文字和背景色表达，不能通过更高阴影假装更重要。

## Shapes

控制和状态行使用12px圆角，普通面板14px，主工作面16px。小型状态徽章使用胶囊形；普通按钮不使用胶囊形。虚线只用于摄像头安全取景框、证据输入组和工坊工单语义。

## Components

### Buttons

- **Primary**：检验蓝实底、白字、42px高，用于建立场次、保存、确认在场和安全播报。
- **Secondary**：白底钢线边框，用于演练、刷新、取消和导出。
- **Danger**：停机红实底，只用于停止演练、暂停AI和人工确认的直播状态动作。
- **Focus**：3px半透明检验蓝外环，且有2px间距。

### Chips

状态徽章同时包含图标和文字。已通过、需人工、阻断、直播中分别使用绿、琥珀、红和实红；不可仅显示彩色圆点。

### Cards / Containers

普通信息尽量使用连续列表、工单或分栏，不把每个数据都做成独立卡片。右侧轨道面板承担门禁、商品和员工在场，主画面保持连续。

### Inputs / Fields

输入框为白底、钢线边框、9–12px圆角。字段名使用小号粗体；未知成本的占位明确写“数据未取得”。证据组用虚线框，标题、来源位置和SHA-256在同一组内。

### Navigation

工坊墨蓝侧栏使用统一线性图标。当前页面显示洗护纸白实底与墨色文字；阻断页以独立琥珀点提示，但仍须进入页面读取文字原因。

### Shift Board

首页主组件把班次时间、状态、真实画面预览、主要动作、试播门禁和经营指标组织成一个工作序列。它不是绩效大屏，数字只服务于当晚是否应该继续。

### Broadcast Overlay

直播输出永久显示猫掌柜、AI主持标识和当前是直播还是本地演练。没有有效商品快照时直接显示“价格待核验”，绝不自动填入9.9元或10元。

## Do's and Don'ts

### Do:

- **Do** 把当前风险、下一动作和恢复办法放在同一视野。
- **Do** 对未知价格、成本、利润和权限写“数据未取得”或“待核验”。
- **Do** 保持直播画面中央大面积留给真实鞋子和手部操作。
- **Do** 为每个高风险动作提供红色停止或人工接管路径。

### Don't:

- **Don't** 使用渐变文字、霓虹、玻璃拟态或数字人科技感作为直播产品身份。
- **Don't** 把内容拆成大量同尺寸图标卡片或用大数字制造虚假进展。
- **Don't** 用颜色替代“已通过、需确认、阻断”等文字。
- **Don't** 让黑猫IP遮挡实景、商品事实或安全提示。

