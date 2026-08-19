# all-encompassing-translate-me

仿 Immersive Translate 的纯 AI 网页双语翻译 Chrome 扩展（wxt + TypeScript，自带 DeepSeek / OpenAI key）。

> 仓库名沿用了本地目录名的拼写 `enconpassing`；package name 与 `~/chrome-extensions/` 安装目录用的是正确拼写 `encompassing`。

## 改完代码怎么让浏览器用上

```bash
pnpm build && node scripts/install-local.mjs   # 装到 ~/chrome-extensions/all-encompassing-translate-me/
```

Chrome 加载的是 `~/chrome-extensions/` 那份，**不是**仓库里的 `.output/`。装完还要用户去 `chrome://extensions` 点「重新加载」才生效——`chrome://` 和 `chrome-extension://` 都被 Claude in Chrome 拒绝访问，AI 点不了，只能请用户点。

## 用 Claude in Chrome 调试视频页面

### 硬规则：先静音

调试 YouTube / B 站等**视频页面**前，**必须先把视频静音**，否则声音会突然从用户的音箱里放出来。

`video.muted = true` **不够**——播放器自己持有音量状态，SPA 切视频时会用它盖回来（本项目实测踩过：设完 muted，点了推荐视频后又响了）。走播放器 API：

```js
const p = document.querySelector('#movie_player');
p.mute();
p.setVolume(0);
const v = document.querySelector('video');
v.muted = true;
v.volume = 0;
```

**每次切视频后都要重新静音一次。**

### 坑：标签页不可见时 requestAnimationFrame 会被完全暂停

字幕 overlay 的渲染循环（`src/core/subtitle/controller.ts` 的 `tick`）挂在 `requestAnimationFrame` 上，导航检测 `syncMedia()` 也在里面。当被调试的标签页不是活动标签、或 Chrome 窗口被其它应用完全遮挡时，Chrome **完全暂停 rAF**（不是降频），于是：

- overlay 冻结在上一帧，字幕不再跟随播放推进；
- 切视频后旧视频的字幕不被清除——**看起来和「串台 bug」一模一样，其实是环境假象**；
- 页面里裸 `await new Promise((r) => requestAnimationFrame(r))` 会永久挂起，CDP 45 秒超时报「renderer may be frozen」。

所以观察任何字幕行为前，**先确认标签页真的可见**（判定要带超时保护，别裸等 rAF）：

```js
const rafAlive = await Promise.race([
  new Promise((res) => requestAnimationFrame(() => res(true))),
  new Promise((res) => setTimeout(() => res(false), 1500)),
]);
document.visibilityState; // 'hidden' 即 rAF 已停
```

`visibilityState === 'hidden'` 时的字幕观察**一律不作数**。要么请用户把 Chrome 窗口切到前台，要么用一次截图触发单帧渲染、紧接着读 DOM（`browser_batch` 里 screenshot + javascript_tool 串起来）。

另外：AI 自己开的标签页会把被测标签页挤成后台（`hidden`），用完立刻 `tabs_close_mcp` 关掉。

### 测 SPA 切视频必须用页面内点击

`navigate` 到另一个视频 URL 会**整页重载**，content script 重新初始化，正好绕开「同一个 controller 跨视频」的场景——那类 bug 一个都测不出来。要测就点页面里的推荐视频卡片，让 YouTube 自己走 SPA 导航（URL 变了、`<video>` 元素被复用）。

### 读 DOM 优先于截图

字幕是否「原文和译文两行相同」这类判断，直接查 `.aetm-caption-source` / `.aetm-caption-target` 的 `textContent` 比看截图准得多，也省 token。注意 `javascript_tool` 的返回值若包含 query string 会被安全过滤拦掉（返回 `[BLOCKED: Cookie/query string data]`），别把 URL 原样返回，只回传需要的字段。
