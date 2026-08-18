#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, '../..')
const CONTRACTS_DIR = resolve(SCRIPT_DIR, 'contracts')
const CANDIDATES_PATH = resolve(CONTRACTS_DIR, 'candidates.json')
const CORES_PATH = resolve(CONTRACTS_DIR, 'cores.json')
const OUTPUT_PATH = resolve(PROJECT_ROOT, 'src/data/arcade-title-catalog.js')
const EXPECTED_CANDIDATES_SHA256 = '3046a5653210d3b15757db3cecc16a77b79cc2374ebf2aedfa12217e271a3042'

// The DAT has stable English identities but no reliable Chinese-name field.
// This source-controlled table provides the reviewed domestic/common base name.
const FAMILY_BASES = Object.fromEntries(String.raw`
1941	1941：反击
1944	1944：环绕大师
19xx	19XX：命运之战
2020bb	2020超级棒球
3countb	三次出击 / 火焰摔跤
3wonders	三奇迹
alpham2	阿尔法任务 II / ASO II：最后守护者
androdun	安多鲁敦
aodk	黑暗格斗霸王
aof	龙虎之拳
aof2	龙虎之拳 2
aof3	龙虎之拳 3：武士之道
armwar	装甲战士
avsp	异形大战铁血战士
b2b	爆裂破坏者
bakatono	霸下殿下麻将漫游记
bangbead	爆裂弹珠
batcir	战斗回路
bjourney	蓝色旅程 / Raguy
blazstar	炽焰之星
breakers	破坏者
breakrev	破坏者：复仇
bstars	职业棒球明星
bstars2	棒球明星 2
burningf	燃烧战斗
captcomm	名将 / Captain Commando
cawing	航空母舰之翼
choko	巧克力
crswd2bl	交叉之剑 2
crsword	交叉之剑
csclub	卡普空体育俱乐部
ctomaday	番茄队长
cworld2j	卡普空世界 2
cyberlip	赛博利普
cybots	机甲战士：全金属狂潮
ddsom	龙与地下城：暗黑秘影
ddtod	龙与地下城：毁灭之塔
diggerma	挖掘机人
dimahoo	大魔法大战
dino	恐龙快打
doubledr	双截龙
dragonsh	龙之天堂
dstlk	恶魔战士：夜之战士
dw	三国志
dynwar	三国志
ecofghtr	生态战士
eightman	八号超人
fatfursp	饿狼传说特别版
fatfury1	饿狼传说
fatfury2	饿狼传说 2
fatfury3	饿狼传说 3：通往最终胜利之路
fbfrenzy	足球狂热
ffight	快打旋风
fightfev	格斗狂热
flipshot	战斗弹球
forgottn	失落的世界
froman2b	偶像麻将：最终浪漫 2
galaxyfg	银河格斗：宇宙战士
ganryu	岩流 / 武藏岩流记
garou	饿狼：狼之印记
ghostlop	幽灵跳
ghouls	大魔界村
gigawing	飞翔之翼
goalx3	进球！进球！进球！
gowcaizr	电压战士：高凯撒
gpilots	幽灵飞行员
gururin	咕噜咕噜
hsf2	超级街头霸王 2X：周年纪念版
ironclad	钢铁冲击 / Iron Clad
janshin	雀神传说：雀王
jockeygp	赛马大奖赛
joyjoy	拼图 / 欢乐小子
jyangoku	雀豪传说：霸王的采配
kabukikl	远东伊甸：歌舞伎格斗
karnovr	卡诺夫的复仇
kf2k3pcb	拳皇 2003
kizuna	羁绊遭遇：超级组队战
knights	圆桌骑士
kod	龙王
kof2000	拳皇 2000
kof2001	拳皇 2001
kof2002	拳皇 2002
kof2003	拳皇 2003
kof94	拳皇 94
kof95	拳皇 95
kof96	拳皇 96
kof97	拳皇 97
kof98	拳皇 98：终极之战 / 梦幻对决
kof99	拳皇 99：千年之战
kotm	怪兽之王
kotm2	怪兽之王 2：下一件事
lastblad	月华剑士
lastbld2	月华剑士 2
lbowling	联盟保龄球
legendos	成功乔的传说
lresort	最后的度假
magdrop2	魔法气泡 2
magdrop3	魔法气泡 3
maglord	魔法领主
mahretsu	麻将狂烈传
marukodq	樱桃小丸子：丸子豪华问答
matrim	武力：豪血寺一族斗魂
megaman	洛克人：力量之战
megaman2	洛克人 2：力量斗士
mercs	佣兵
miexchng	金钱拼图交换者
minasan	大家托您的福！大富翁大会
mmancp2u	洛克人：力量之战
mmatrix	火星矩阵
moshougi	将棋达人
mpang	超级棒！
msh	漫威超级英雄
mshvsf	漫威超级英雄大战街头霸王
mslug	合金弹头
mslug2	合金弹头 2
mslug3	合金弹头 3
mslug4	合金弹头 4
mslug5	合金弹头 5
mslugx	合金弹头 X
msword	魔剑：英雄幻想
mtwins	双胞胎奇迹
mutnat	变异国家
mvsc	漫画英雄大战卡普空
nam1975	越战 1975
ncombat	忍者战斗
ncommand	忍者突击队
nemo	尼莫
neobombe	新炸弹人
neocup98	新街机足球杯 98
neodrift	新漂移赛车
neomrdo	新马里奥先生
neopong	新乒乓
ninjamas	忍者大师
nitd	黑暗中的梦魇
nwarr	恶魔战士：暗黑复仇
overtop	极速越野
pang3	泡泡龙 3
panicbom	炸弹危机
pbobbl2n	泡泡龙 2
pbobblen	泡泡龙
pgoal	欢乐足球
pnickj	皮克尼克
pnyaa	波奇与喵
popbounc	弹跳泡泡
preisle2	史前岛 2
progear	战机少女
pspikes2	力量扣杀 2
pulstar	脉冲星
punisher	惩罚者
puzzldpr	益智之邦 R
puzzledp	益智之邦
pzloop2	益智循环 2
qad	问答与龙
qndream	七彩问答梦
qtono2j	殿様问答 2
quizdai2	问答侦探 Neo & Geo 2
quizdais	问答大搜查线
quizkof	拳皇问答
ragnagrd	神凰拳
rbff1	饿狼传说：真实战斗
rbff2	饿狼传说 2：真实战斗
rbffspec	饿狼传说：真实战斗特别版
ringdest	毁灭之环：摔角大师 2
roboarmy	机器军团
rotd	龙之怒
s1945p	打击者 1945 Plus
samsh5sp	侍魂：零特别版
samsho	侍魂
samsho2	侍魂 2
samsho3	侍魂 3
samsho4	侍魂 4：天草降临
samsho5	侍魂 5：天下一剑客传
savagere	野兽王朝
sbp	超级泡泡
sdodgeb	超级躲避球
sengoku	战国传承
sengoku2	战国传承 2
sengoku3	战国传承 3
sf2	街头霸王 2：世界勇士
sf2ce	街头霸王 2：冠军版
sf2hf	街头霸王 2：极速版
sfa	街头霸王 Alpha
sfa2	街头霸王 Alpha 2
sfa3	街头霸王 Alpha 3
sfz2al	街头霸王 ZERO 2 Alpha
sfzch	街头霸王 ZERO
sgemf	口袋战士
shocktr2	突击队：第二小队
shocktro	突击队
slammast	肌肉炸弹
socbrawl	足球大乱斗
sonicwi2	空战奇兵 2 / Sonic Wings 2
sonicwi3	空战奇兵 3 / Sonic Wings 3
spf2t	超级拼图战士 2 Turbo
spinmast	旋风冒险
ssf2	超级街头霸王 2：新挑战者
ssf2t	超级街头霸王 2X
ssideki	超级边锋
ssideki2	超级边锋 2
ssideki3	超级边锋 3
ssideki4	终极 11：SNK 足球冠军
stakwin	赌马赢家
stakwin2	赌马赢家 2
strhoop	街头篮球
strider	出击飞龙
superspy	超级间谍
svc	SNK 对 卡普空：SVC 混沌
tophuntr	顶尖猎人
tpgolf	顶尖高尔夫
trally	疯狂拉力
turfmast	新高尔夫大师
twinspri	双星精灵
twsoc96	Tecmo 世界足球 96
unsquad	空战之路 / U.N.中队
varth	雷电风暴
vhunt2	吸血鬼猎人 2：暗黑复仇
viewpoin	视点
vliner	V-Liner 拉霸机
vsav	吸血鬼救世主
vsav2	吸血鬼救世主 2
wakuwak7	哇库哇库 7
wh1	世界英雄
wh2	世界英雄 2
wh2j	世界英雄 2 Jet
whp	世界英雄完美版
willow	柳树
wjammers	风云战士 / 飞翔力量盘
wof	吞食天地 2：赤壁之战
xmcota	X 战警：原子之子
xmvsf	X 战警大战街头霸王
zedblade	Zed 战刃 / 诸神黄昏行动
zintrckb	魔法方块
zupapa	祖帕帕
`.trim().split('\n').map((line) => line.split('\t')))
const SET_BODY_OVERRIDES = Object.fromEntries(String.raw`
area88	空战之路
area88r	空战之路
daimakai	大魔界村
daimakair	大魔界村
dwj	三国志
dynwarj	三国志
dynwarjr	三国志
ffightjh	街头智能 / 快打旋风
gmahou	大魔法大战
lostwrld	失落的世界
lostwrldo	失落的世界
pfghtj	口袋战士
pgear	动力装甲：战略变体装甲装备
pgearr1	动力装甲：战略变体装甲装备
progearj	战机少女
progearjbl	战机少女
rmancp2j	洛克人：力量之战
rockmanj	洛克人：力量之战
rockman2j	洛克人 2：力量斗士
sf2t	街头霸王 2：极速版
sf2tj	街头霸王 2：极速版
sfz2a	街头霸王 ZERO 2
sfz2b	街头霸王 ZERO 2
sfz2br1	街头霸王 ZERO 2
sfz2h	街头霸王 ZERO 2
sfz2j	街头霸王 ZERO 2
sfz2jr1	街头霸王 ZERO 2
sfz2n	街头霸王 ZERO 2
sfz3a	街头霸王 ZERO 3
sfz3ar1	街头霸王 ZERO 3
sfz3j	街头霸王 ZERO 3
sfz3jr1	街头霸王 ZERO 3
sfz3jr2	街头霸王 ZERO 3
sfza	街头霸王 ZERO
sfzar1	街头霸王 ZERO
sfzb	街头霸王 ZERO
sfzbr1	街头霸王 ZERO
sfzh	街头霸王 ZERO
sfzhr1	街头霸王 ZERO
sfzj	街头霸王 ZERO
sfzjr1	街头霸王 ZERO
sfzjr2	街头霸王 ZERO
smbomb	超级肌肉炸弹
smbombr1	超级肌肉炸弹
spf2xj	超级拼图战士 2X
ssf2tb	超级街头霸王 2：锦标赛战
ssf2tbh	超级街头霸王 2：锦标赛战
ssf2tbj	超级街头霸王 2：锦标赛战
ssf2tbr1	超级街头霸王 2：锦标赛战
ssf2xj	超级街头霸王 2X：终极挑战
ssf2xjr	超级街头霸王 2X：终极挑战
striderj	出击飞龙
striderjr	出击飞龙
stridrja	出击飞龙
uecology	终极生态
vampj	吸血鬼：夜之战士
vampja	吸血鬼：夜之战士
vampjr1	吸血鬼：夜之战士
vhuntj	吸血鬼猎人：暗黑复仇
vhuntjr1	吸血鬼猎人：暗黑复仇
vhuntjr1s	吸血鬼猎人：暗黑复仇
vhuntjr2	吸血鬼猎人：暗黑复仇
wofa	吞食天地 2：赤壁之战
wofj	吞食天地 2：赤壁之战
wofhfh	火凤凰
wonder3	三奇迹
3wondersh	三奇迹
aof3k	龙虎之拳 3
ct2k3sp	猛虎隐龙 2003
cthd2003	猛虎隐龙 2003
dinohunt	恐龙快打
dinoj	恐龙新世纪
fswords	剑客之刃
kf10thep	拳皇 2002：十周年 Extra Plus
kf2k2mp	拳皇 2002：魔法加强版
kf2k2mp2	拳皇 2002：魔法加强版 II
kf2k2pla	拳皇 2002：Plus
kf2k2pls	拳皇 2002：Plus
kf2k5uni	拳皇 2002：十周年 2005 Unique
kof10th	拳皇 2002：十周年纪念版
kof2k4se	拳皇 2002：特别版 2004
kof2002b	拳皇 2002
kf2k3bl	拳皇 2004：Plus / Hero
kf2k3bla	拳皇 2004：Plus / Hero
kf2k3pl	拳皇 2004：Plus / Hero
kf2k3upl	拳皇 2004：Ultra Plus
kof97oro	拳皇 97：冲出江湖 Plus 2003
kof97pls	拳皇 97：Plus
kog	角斗士之王
ms4plus	合金弹头 4：Plus
ms5plus	合金弹头 5：Plus
mslug2t	合金弹头 2：Turbo
mslug3b6	合金弹头 6
svcboot	SNK 对 卡普空：SVC 混沌
svcplus	SNK 对 卡普空：SVC 混沌 Plus
svcplusa	SNK 对 卡普空：SVC 混沌 Plus
svcsplus	SNK 对 卡普空：SVC 混沌 Super Plus
sf2acc	街头霸王 2：冠军版 Accelerator
sf2acca	街头霸王 2：冠军版 Accelerator
sf2accp2	街头霸王 2：冠军版 Accelerator Part II
sf2ceeab2	街头霸王 2：冠军版
sf2ceuabl	街头霸王 2：冠军版
sf2dkot2	街头霸王 2：冠军版 Double K.O. Turbo II
sf2ebbl	街头霸王 2：世界勇士
sf2koryu	街头霸王 2：冠军版 Kouryu
sf2m4	街头霸王 2：冠军版 M4
sf2m5	街头霸王 2：冠军版 M5
sf2m6	街头霸王 2：冠军版 M6
sf2m7	街头霸王 2：冠军版 M7
sf2rb	街头霸王 2：冠军版 Rainbow
sf2rb2	街头霸王 2：冠军版 Rainbow
sf2rb3	街头霸王 2：冠军版 Rainbow
sf2rb4	街头霸王 2：冠军版 Rainbow
sf2red	街头霸王 2：冠军版 Red Wave
sf2v004	街头霸王 2：冠军版 V004
mbomberj	肌肉炸弹
mbombrd	肌肉炸弹 Duo：终极组队战
mbombrdj	肌肉炸弹 Duo：热血战士
stridrja	出击飞龙
crswd2bl	交叉之剑 2
froman2b	偶像麻将：最终浪漫 2
zintrckb	魔法方块
zintrkcd	魔法方块
`.trim().split('\n').map((line) => line.split('\t')))

const LEGACY_ALIASES = {
  kof97: ['KOF97', '拳皇97'],
  kof97oro: ['KOF97 Orochi', '拳皇97风云再起'],
  mslug: ['Metal Slug', '合金弹头'],
  mslug2: ['Metal Slug 2', '合金弹头2'],
  mslug3: ['Metal Slug 3', '合金弹头3'],
  mslug4: ['Metal Slug 4', '合金弹头4'],
  mslug5: ['Metal Slug 5', '合金弹头5'],
}

const REGION_REPLACEMENTS = [
  [/\bJapanese\b/giu, '日文版'],
  [/\bJapan\b/giu, '日本版'],
  [/\bUSA\b/giu, '美国版'],
  [/\bUS\b/giu, '美国版'],
  [/\bWorld\b/giu, '世界版'],
  [/\bEuro(?:pe)?\b/giu, '欧洲版'],
  [/\bAsia\b/giu, '亚洲版'],
  [/\bBrazil\b/giu, '巴西版'],
  [/\bHispanic\b/giu, '西班牙语版'],
  [/\bKorean\b/giu, '韩国版'],
  [/\bOceania\b/giu, '大洋洲版'],
  [/\bTaiwan\b/giu, '台湾版'],
  [/\bChinese\b/giu, '中国版'],
]

const QUALIFIER_REPLACEMENTS = [
  [/\bJapan\s+Resale\s+Ver\.?/giu, '日本再发行版'],
  [/\bJapan\s+Old\s+ver\.?/giu, '日本旧版'],
  [/\bRent\s+version\b/giu, '租赁版'],
  [/\bstop\s+version\b/giu, '停止版'],
  [/\bSAMPLE\s+Version\b/giu, '样本版'],
  [/\bNeo\s+CD\s+conversion\b/giu, 'Neo CD 移植版'],
  [/\bdevelopment\s+board\b/giu, '开发板'],
  [/\bsingle\s+PCB\b/giu, '单 PCB 版'],
  [/\bNCI\s+release\b/giu, 'NCI 发行版'],
  [/\bCPS\s+Changer\b/giu, 'CPS 家用主机版'],
  [/\bwonder\s+3\b/giu, '三奇迹'],
  [/\bU\.S\.\s+navy\b/giu, '美国海军'],
  [/\bChinese\s+bootleg\s+of\s+Cadillacs\s+and\s+Dinosaurs\b/giu, '《恐龙快打》的中国盗版'],
  [/\bChinese\s+bootleg\s+of\s+The\s+Punisher\b/giu, '《惩罚者》的中国盗版'],
  [/\bChinese\s+bootleg\s+of\s+Sangokushi\s+II\b/giu, '《吞食天地 2》的中国盗版'],
  [/\bKorean\s+release\s+of\s+Samurai\s+Shodown\s+II\b/giu, '《侍魂 2》的韩国发行版'],
  [/\bKorean\s+release\s+of\s+Samurai\s+Shodown\s+III\b/giu, '《侍魂 3》的韩国发行版'],
  [/\bKorean\s+release\s+of\s+The\s+Last\s+Blade\b/giu, '《月华剑士》的韩国发行版'],
  [/\bKorean\s+censored\s+Samurai\s+Shodown\s+IV\b/giu, '《侍魂 4》的韩国审查版'],
  [/\bKorean\s+localized\s+Quiz\s+Daisousa\s+Sen\b/giu, '《问答大搜查线》的韩国本地化版'],
  [/\bbootleg\s+of\s+CD\s+version\b/giu, 'CD 版盗版'],
  [/\bbootleg\s+of\s+The\s+King\s+of\s+Fighters\s+2001\b/giu, '《拳皇 2001》盗版'],
  [/\bbootleg\s+of\s+The\s+King\s+of\s+Fighters\s+2002\b/giu, '《拳皇 2002》盗版'],
  [/\bbootleg\s+of\s+The\s+King\s+of\s+Fighters\s+2003\b/giu, '《拳皇 2003》盗版'],
  [/\bbootleg\s+of\s+The\s+King\s+of\s+Fighters\s+'97\b/giu, '《拳皇 97》盗版'],
  [/\bhack\s+of\s+The\s+King\s+of\s+Fighters\s+2001\b/giu, '《拳皇 2001》改版'],
  [/\bbootleg\s+of\s+Shock\s+Troopers\s+-\s+2nd\s+Squad\b/giu, '《突击队：第二小队》盗版'],
  [/\bbootleg\s+of\s+Metal\s+Slug\s+3\b/giu, '《合金弹头 3》盗版'],
  [/\bbootleg\s+of\s+Samurai\s+Shodown\s+III\b/giu, '《侍魂 3》盗版'],
  [/\bbootleg\s+of\s+Cadillacs\s+and\s+Dinosaurs\b/giu, '《恐龙快打》盗版'],
  [/\bbootleg\s+of\s+The\s+Punisher\b/giu, '《惩罚者》盗版'],
  [/\bbootleg\s+of\s+Sangokushi\s+II\b/giu, '《吞食天地 2》盗版'],
  [/\bbug\s+fix\s+revision\b/giu, '修复版'],
  [/\bFully\s+Decrypted\b/giu, '完全解密版'],
  [/\bdecrypted\s+set\b/giu, '解密版'],
  [/\bnon-encrypted\s+program\b/giu, '未加密程序版'],
  [/\bnot\s+encrypted\b/giu, '未加密版'],
  [/\b2nd\s+release\b/giu, '第二次发行'],
  [/\b1st\s+release\b/giu, '首次发行'],
  [/\bless\s+censored\b/giu, '低审查版'],
  [/\bSuper\s+Puzzle\s+Fighter\s+2\s+Turbo\b/giu, '超级拼图战士 2 Turbo'],
  [/\bSuper\s+Puzzle\s+Fighter\s+2\s+X\b/giu, '超级拼图战士 2X'],
  [/\bsuper\s+street\s+fighter\s+2\s+X\b/giu, '超级街头霸王 2X'],
  [/\bsuper\s+street\s+fighter\s+2\b/giu, '超级街头霸王 2'],
  [/\bstreet\s+fighter\s+2'\s*T(?=\s|$)/giu, '街头霸王 2 T'],
  [/\bstreet\s+fighter\s+2'(?=\s|$)/giu, '街头霸王 2'],
  [/\bwonder\s+3\b/giu, '三奇迹'],
  [/\bnanairo\s+dreams\b/giu, '七彩梦'],
  [/\btonosama\s+2\b/giu, '殿様 2'],
  [/\bprototype\b/giu, '原型版'],
  [/\bcensored\b/giu, '审查版'],
  [/\bDouble\s+K\.O\.\s+Turbo\b/giu, '双 KO 极速版'],
  [/\bSuper\s+Plus\b/giu, '超级加强版'],
  [/\bUltra\s+Plus\b/giu, '终极加强版'],
  [/\bExtra\s+Plus\b/giu, '特别加强版'],
  [/\bAccelerator\b/giu, '加速版'],
  [/\bRainbow\b/giu, '彩虹版'],
  [/\bRed\s+Wave\b/giu, '红浪版'],
  [/\bUnique\b/giu, '独特版'],
  [/\bHero\b/giu, '英雄版'],
  [/\bPart\s+II\b/giu, '第二部分'],
  [/\bPt\.II\b/giu, '第二部分'],
  [/\bEdition\b/giu, '版'],
  [/\bDuo\b/giu, '双人版'],
  [/\bJet\b/giu, '喷气版'],
  [/\bTurbo\b/giu, '极速版'],
  [/\bPlus\b/giu, '加强版'],
  [/\bbootleg\b/giu, '盗版'],
  [/\bhack\b/giu, '改版'],
  [/\bset\s*(\d+)\b/giu, '第$1套'],
  [/\b(?:revision|rev\.?)\s*([A-Z]+)\b/giu, '修订版 $1'],
  [/\bVer\.?\s*(\d[\w.]*)/giu, '版本 $1'],
  [/\bOld\s+ver\.?/giu, '旧版'],
  [/\bnew\s+ver\.?/giu, '新版'],
  [/\bKorean\s+localized\b/giu, '韩国本地化版'],
  [/\bKorean\s+release\b/giu, '韩国发行版'],
  [/\bU\.S\./giu, '美国'],
  [/\bKorea\b/giu, '韩国版'],
  [/\bEnglish\b/giu, '英文版'],
  [/\bExport\b/giu, '出口版'],
  [/\bearlier\b/giu, '早期版'],
  [/\bolder\b/giu, '早期版'],
  [/\balt\b/giu, '替代版'],
  [/\bwith\b/giu, '含'],
  [/\bboard\b/giu, '基板'],
  [/\brelease\b/giu, '发行版'],
  [/\bversion\b/giu, '版本'],
  [/\betc\b/giu, '等'],
  [/\bof\b/giu, '的'],
  [/\bHB\b/giu, '自制版'],
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function splitTitle(title) {
  let body = String(title).trim()
  const qualifiers = []
  while (true) {
    const match = body.match(/\s+\(([^()]*)\)$/u)
    if (!match) break
    qualifiers.unshift(match[1])
    body = body.slice(0, match.index).trim()
  }
  return { body, qualifiers }
}

function translateQualifier(value) {
  let translated = String(value).trim()
  for (const [pattern, replacement] of QUALIFIER_REPLACEMENTS) {
    translated = translated.replace(pattern, replacement)
  }
  for (const [pattern, replacement] of REGION_REPLACEMENTS) {
    translated = translated.replace(pattern, replacement)
  }
  return translated
    .replace(/\s*,\s*/gu, '，')
    .replace(/\s+/gu, ' ')
    .trim()
}

function rootForSet(setName, rowsBySet) {
  let current = rowsBySet.get(setName)
  const seen = new Set()
  while (current?.datParentSetName && rowsBySet.has(current.datParentSetName) && !seen.has(current.setName)) {
    seen.add(current.setName)
    current = rowsBySet.get(current.datParentSetName)
  }
  return current?.datParentSetName && !rowsBySet.has(current.datParentSetName)
    ? current.datParentSetName
    : current?.setName || setName
}

function directFamilyForRow(row) {
  return row.runtimeParentSetName || row.datParentSetName || row.setName
}

function translateNamedBody(value) {
  let translated = String(value)
  const replacements = [
    [/Double\s+K\.O\.\s+Turbo/giu, '双 KO 极速版'],
    [/Super\s+Plus/giu, '超级加强版'],
    [/Ultra\s+Plus/giu, '终极加强版'],
    [/Extra\s+Plus/giu, '特别加强版'],
    [/Accelerator/giu, '加速版'],
    [/Rainbow/giu, '彩虹版'],
    [/Red\s+Wave/giu, '红浪版'],
    [/Unique/giu, '独特版'],
    [/Hero/giu, '英雄版'],
    [/Part\s+II/giu, '第二部分'],
    [/Pt\.II/giu, '第二部分'],
    [/Duo/giu, '双人版'],
    [/Turbo/giu, '极速版'],
    [/Plus/giu, '加强版'],
  ]
  for (const [pattern, replacement] of replacements) translated = translated.replace(pattern, replacement)
  return translated
}

function comparableText(value) {
  return String(value)
    .replace(/[\s!！:：,，.。/'’-]/gu, '')
    .toLocaleLowerCase('en-US')
}

function removeRepeatedBodyQualifier(value, base) {
  const parts = String(value).split('，')
  const first = comparableText(parts[0])
  if (first && comparableText(base).includes(first)) parts.shift()
  return parts.join('，')
}

function buildTitleZh(row, rowsBySet) {
  const { qualifiers } = splitTitle(row.title)
  const translationRoot = rootForSet(row.setName, rowsBySet)
  const reviewedBase = SET_BODY_OVERRIDES[row.setName]
    || FAMILY_BASES[translationRoot]
    || FAMILY_BASES[row.setName]
  if (!reviewedBase) throw new Error(`missing reviewed Chinese family name for ${row.setName} (root ${translationRoot})`)
  const base = translateNamedBody(reviewedBase)
  const translatedQualifiers = qualifiers
    .map(translateQualifier)
    .map((value) => removeRepeatedBodyQualifier(value, base))
    .filter(Boolean)
  const lowerTitle = row.title.toLocaleLowerCase('en-US')
  if (row.relationKind === 'bootleg' && !/bootleg/iu.test(lowerTitle) && !translatedQualifiers.some((value) => /盗版/u.test(value))) {
    translatedQualifiers.push('盗版')
  }
  if (row.relationKind === 'hack' && !/hack/iu.test(lowerTitle) && !translatedQualifiers.some((value) => /改版/u.test(value))) {
    translatedQualifiers.push('改版')
  }
  return `${base}${translatedQualifiers.map((value) => `（${value}）`).join('')}`
}

function aliasesFor(row, titleZh, rowsBySet) {
  const { body } = splitTitle(row.title)
  const family = rootForSet(row.setName, rowsBySet)
  const aliases = [
    row.setName,
    row.setName.toUpperCase(),
    row.id,
    row.title,
    body,
    titleZh,
    titleZh.replace(/[\s：:！!，,。]/gu, ''),
    family,
    ...(row.sourceSetNames || []),
    ...(LEGACY_ALIASES[row.setName] || []),
  ]
  return [...new Set(aliases.filter((value) => String(value || '').trim()))]
}

function buildRows(candidates, cores) {
  const coreByArtifactId = new Map(cores.cores.map((core) => [core.id, core]))
  const rowsBySet = new Map(candidates.rows.map((row) => [row.setName, row]))
  const rows = candidates.rows.map((candidate) => {
    const core = coreByArtifactId.get(candidate.coreArtifactId)
    if (!core) throw new Error(`candidate ${candidate.id} references unknown core ${candidate.coreArtifactId}`)
    const titleZh = buildTitleZh(candidate, rowsBySet)
    const key = `${core.coreName}:${candidate.setName}`
    return {
      key,
      coreName: core.coreName,
      setName: candidate.setName,
      titleZh,
      titleEn: candidate.title,
      familyRootSetName: directFamilyForRow(candidate),
      datParentSetName: candidate.datParentSetName,
      relationKind: candidate.relationKind,
      source: 'domestic-common-name+dat-qualifier',
      confidence: 'reviewed',
      aliases: aliasesFor(candidate, titleZh, rowsBySet),
    }
  }).sort((left, right) => compareStrings(left.key, right.key))
  return rows
}

function renderModule(rows, candidatesSha256) {
  const rowsJson = JSON.stringify(rows, null, 2)
  const catalogSha256 = sha256(`${JSON.stringify(rows)}\n`)
  return `// Generated by tools/arcade-import/generate-title-catalog.mjs.\n// Do not edit manually; update the reviewed tables in the generator instead.\n\nexport const ARCADE_TITLE_CANDIDATES_SHA256 = ${JSON.stringify(candidatesSha256)}\nexport const ARCADE_TITLE_CATALOG_SHA256 = ${JSON.stringify(catalogSha256)}\n\nexport const ARCADE_TITLE_ROWS = Object.freeze(${rowsJson}.map((row) => Object.freeze({\n  ...row,\n  aliases: Object.freeze(row.aliases),\n})))\n\nexport const ARCADE_TITLE_BY_KEY = new Map(\n  ARCADE_TITLE_ROWS.map((row) => [row.key, row]),\n)\nObject.freeze(ARCADE_TITLE_BY_KEY)\n`
}

async function main() {
  const [candidateBytes, coresBytes] = await Promise.all([
    readFile(CANDIDATES_PATH),
    readFile(CORES_PATH, 'utf8'),
  ])
  const candidatesSha256 = sha256(candidateBytes)
  if (candidatesSha256 !== EXPECTED_CANDIDATES_SHA256) {
    throw new Error(`candidates.json SHA-256 changed: expected ${EXPECTED_CANDIDATES_SHA256}, got ${candidatesSha256}`)
  }
  const candidates = JSON.parse(candidateBytes)
  const cores = JSON.parse(coresBytes)
  if (candidates.rows.length !== 656) throw new Error(`expected 656 candidates, got ${candidates.rows.length}`)
  const rows = buildRows(candidates, cores)
  if (rows.length !== 656 || new Set(rows.map((row) => row.key)).size !== 656) {
    throw new Error('generated title catalog does not contain 656 unique keys')
  }
  if (rows.some((row) => !row.titleZh.trim())) throw new Error('generated title catalog contains an empty Chinese title')
  await mkdir(dirname(OUTPUT_PATH), { recursive: true })
  await writeFile(OUTPUT_PATH, renderModule(rows, candidatesSha256), 'utf8')
  process.stdout.write(JSON.stringify({
    output: OUTPUT_PATH,
    rows: rows.length,
    candidatesSha256,
    catalogSha256: sha256(`${JSON.stringify(rows)}\n`),
  }) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

export {
  FAMILY_BASES,
  SET_BODY_OVERRIDES,
  buildRows,
  splitTitle,
  translateQualifier,
}
