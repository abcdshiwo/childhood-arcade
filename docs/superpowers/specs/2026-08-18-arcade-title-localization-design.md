# 街机标题本地化设计

## 目标

为当前公共街机目录的全部 656 个候选补充常用中文译名，同时保留 W165/DAT 的完整英文原名可搜索、可读、可审计。中文名用于图库主标题；英文原名在其下方以低透明度小字显示。未来新增 ROM 没有目录条目时仍应正常回退到现有英文标题。

## 约束与不变量

- 不修改 `roms.title`、数据库 schema、导入批次、ROM 文件、build 指纹或房间存储数据。
- 目录键必须是 `coreName:setNameNormalized`，因为英文标题并不唯一，且同一 set 可能由不同核心提供。
- 目录中的 `titleEn` 必须逐字匹配冻结候选合同 `tools/arcade-import/contracts/candidates.json` 的 `title`；合同 SHA-256 为 `3046a5653210d3b15757db3cecc16a77b79cc2374ebf2aedfa12217e271a3042`，W165 manifest SHA-256 为 `c2e0ad6805235e143452bfc084778de79103b0888a83fa36875f8422f10447bc`。
- 关系、地区、日期、修订版、Bootleg、HACK 等限定信息不能在中文名中被静默丢弃；每条记录保留 `aliases` 供搜索。
- 译名目录是前端只读静态数据，不提供运行时用户编辑入口；目录缺失、字段不完整或英文哈希不匹配时构建/测试失败。

## 数据形状

新增 `src/data/arcade-title-catalog.js`，导出不可变数组和按键索引：

```js
{
  key: 'fbneo:kof97',
  titleZh: '拳皇 97',
  titleEn: "The King of Fighters '97",
  familyRootSetName: 'kof97',
  datParentSetName: null,
  relationKind: 'parent',
  source: 'manual-domestic-common-name',
  confidence: 'reviewed',
  aliases: ['KOF97', '拳皇97']
}
```

生成脚本同时读取候选合同与 `cores.json`，把每行 `coreArtifactId` 映射成真实 API `coreName`；不能直接把候选的 `source=fbalpha2012` 当作 core，因为这些行实际分配到 `fbalpha2012_cps1`、`fbalpha2012_cps2` 和 `fbalpha2012`。脚本按跨核心的全局 set parent/family 关系继承基础中文名，再应用显式版本覆盖；输出固定排序文件和 `catalogSha256`。每条合同必须恰好一条目录记录，重复英文标题也必须保持 set 级别区分。

新增 `src/composables/useArcadeTitle.js`（纯函数也可单测）提供：

- `getArcadeTitle(rom)`：返回 `{ titleZh, titleEn, aliases, ... }`，未命中时 `titleZh=rom.title`、`titleEn=rom.originalTitle || rom.title`。
- `arcadeSearchText(rom)`：合并中文、英文、别名、旧标题、set、版本、核心、平台和关系字段并统一大小写。
- `arcadeCardLabel(rom)`：生成可访问的中文/英文/set 标签。

## 前端行为

- Gallery 卡片的 `.game-title` 显示中文名；当英文原名非空且与中文显示不同，紧邻渲染 `.game-title-en`，透明度约 `0.58`、最多两行、固定最小高度，长标题不改变网格布局。
- 搜索使用共享 `arcadeSearchText`，中文名、英文原名、旧标题别名、set、版本、core 和平台均可匹配；不依赖服务器新增字段。
- 图片 alt、卡片 `aria-label`、收藏按钮 title 同时使用中文主名和英文副名，保证屏幕阅读器仍能定位原始 set。
- Player 顶栏和 Rooms 列表在已有 ROM 元数据可用时复用同一显示辅助函数；英文原名以次要文本显示，不改变房间 API 的 `romTitle` 语义。
- API/数据库异常或旧客户端数据缺字段时回退到 `rom.title`，不显示空白或 `undefined`。

## 测试与验收

先写失败测试，再实现：

1. 目录完整性：合同 656 条与目录 key 一一对应，`titleEn` 逐字匹配，目录哈希稳定，无重复/缺失。
2. 展示：Gallery 显示中文主标题和半透明英文副标题；中文、英文、别名和 set 搜索都命中；未命中条目正确回退。
3. 可访问性与布局：alt/aria 同时包含两种名称；长英文标题最多两行；桌面和窄屏卡片不溢出。
4. 共享辅助函数：Player/Rooms 使用同一标题解析结果，不改变原有路由和房间字段。

完成标准是全部现有 Node、组件和浏览器测试通过，新增目录完整性测试通过，生产构建成功；部署仅替换前端 release，保留现有数据库、服务自启、Nginx 和其他站点。
