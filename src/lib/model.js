/**
 * 纯逻辑：把豆瓣 interests 接口的原始条目归一化成扩展内部模型。
 *
 * 只做字段映射与缺失容忍，不发请求，方便单测。
 */

/** @typedef {'movie'|'tv'|'book'} Category */

/**
 * 豆瓣把电影与剧集混在 type=movie 下，用条目自身的 type 区分。
 * @param {any} subject
 * @returns {Category}
 */
export function categoryOf(subject) {
  const t = subject?.type
  if (t === 'tv') return 'tv'
  if (t === 'book') return 'book'
  return 'movie'
}

/** 把可能为空的数值转成数字或 undefined */
function num(v) {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/**
 * 评分：豆瓣用 0 表示「暂无评分 / 未评分」，这类值应视为缺失，
 * 否则界面上会显示「豆瓣 0.0」或一排空星。
 */
function ratingOf(v) {
  const n = num(v)
  return n != null && n > 0 ? n : undefined
}

/** 把可能为空的字符串转成非空字符串或 undefined */
function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * @param {any} raw  接口 interests[] 中的一项
 * @returns {object|null} 无法识别出 subject.id 时返回 null
 */
export function normalizeInterest(raw) {
  const subject = raw?.subject
  const subjectId = subject?.id != null ? String(subject.id) : undefined
  if (!subjectId) return null

  const category = categoryOf(subject)

  return {
    key: `${category}:${subjectId}`,
    category,
    subjectId,
    title: str(subject.title) ?? '（无标题）',
    year: str(subject.year),
    coverUrl: str(subject.cover_url) ?? str(subject.pic?.large) ?? str(subject.pic?.normal),
    url: str(subject.url) ?? `https://www.douban.com/subject/${subjectId}/`,
    doubanRating: ratingOf(subject.rating?.value),
    subtitle: str(subject.card_subtitle),
    // 条目在豆瓣里的标记状态：mark / doing / done。界面据此显示「来自『想看』」
    status: str(raw?.status) ?? 'mark',
    // 以下三项可能缺失：v2 的豆列来源没有「我的」数据
    myRating: ratingOf(raw?.rating?.value),
    myComment: str(raw?.comment),
    markedAt: num(raw?.create_time),
    isPrivate: raw?.is_private === true,
  }
}

/**
 * @param {any[]} raws
 * @returns {object[]}
 */
export function normalizeInterests(raws) {
  const seen = new Set()
  const out = []
  for (const raw of raws ?? []) {
    const item = normalizeInterest(raw)
    if (!item || seen.has(item.key)) continue
    seen.add(item.key)
    out.push(item)
  }
  return out
}
