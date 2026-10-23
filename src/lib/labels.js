/**
 * 标签体系。
 *
 * 界面上的「来源」「状态」「类别」都走标签，不再用纯文本。
 * 以后新增候选来源（豆列、公开片单等）时，只需要在这里加一种 tone，
 * 不用再改各个页面的渲染逻辑。
 */

export const CATEGORY_LABEL = { movie: '电影', tv: '剧集', book: '图书' }
export const CATEGORY_UNIT = { movie: '部电影', tv: '部剧集', book: '本书' }

/**
 * 来源标签：这条在豆瓣里是怎么被标记的。
 * tone 对应 CSS 里的 .tag-want / .tag-doing / .tag-done
 */
export function sourceTag(record) {
  const book = record.category === 'book'
  switch (record.markStatus) {
    case 'doing':
      return { label: book ? '在读' : '在看', tone: 'doing' }
    case 'done':
      return { label: book ? '读过' : '看过', tone: 'done' }
    case 'mark':
    default:
      return { label: book ? '想读' : '想看', tone: 'want' }
  }
}

/** 决定状态标签：待看 / 跳过 / 看过 */
export function stateTag(record) {
  const book = record.category === 'book'
  switch (record.state) {
    case 'done':
      return { label: book ? '读过' : '看过', tone: 'done' }
    case 'skipped':
      return { label: '跳过', tone: 'skipped' }
    default:
      return { label: book ? '待读' : '待看', tone: 'pending' }
  }
}

/** 生成一个标签元素 */
export function renderTag({ label, tone }, extraClass = '') {
  const span = document.createElement('span')
  span.className = `tag tag-${tone} ${extraClass}`.trim()
  span.textContent = label
  return span
}
