/**
 * 纯逻辑：来源（想看 / 看过）。
 *
 * 来源只在需要时加载；候选集由候选池页的勾选决定。
 *   mark  想看 / 想读
 *   done  看过 / 读过（重温）
 */

/** 允许的来源，顺序即界面上的顺序 */
export const SOURCES = ['mark', 'done']

/** 缺失或非法时按「两个来源都包含」处理，保持升级前的行为 */
export const DEFAULT_SCOPE = ['mark', 'done']

/** 界面文案。图书与电影共用一套，避免「看过 / 读过」二选一的判断散落各处 */
export const SCOPE_LABEL = {
  mark: '想看 / 想读',
  done: '看过 / 读过',
}

/**
 * 把任意输入收敛成合法的来源数组。
 * 空数组或全是非法值时退回默认范围——调用方要拒绝空范围，必须自己先判断。
 */
export function normalizeScope(value) {
  if (!Array.isArray(value)) return DEFAULT_SCOPE.slice()
  const out = SOURCES.filter((source) => value.includes(source))
  return out.length ? out : DEFAULT_SCOPE.slice()
}

/** 条目的来源：只有 done 才是重温，mark / doing 都算想看 */
export function sourceOf(item) {
  return item?.status === 'done' ? 'done' : 'mark'
}

