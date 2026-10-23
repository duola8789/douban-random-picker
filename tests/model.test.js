import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeInterest, normalizeInterests, categoryOf } from '../src/lib/model.js'

const movieRaw = {
  status: 'mark',
  comment: '想看很久了',
  rating: { value: 4 },
  create_time: 1700000000,
  is_private: false,
  subject: {
    id: '26752088',
    title: '我不是药神',
    url: 'https://movie.douban.com/subject/26752088/',
    cover_url: 'https://img.example/cover.jpg',
    year: '2018',
    type: 'movie',
    rating: { value: 9.0 },
    card_subtitle: '2018 / 文牧野 / 徐峥',
  },
}

test('电影条目归一化', () => {
  const item = normalizeInterest(movieRaw)
  assert.equal(item.key, 'movie:26752088')
  assert.equal(item.category, 'movie')
  assert.equal(item.myRating, 4)
  assert.equal(item.myComment, '想看很久了')
  assert.equal(item.doubanRating, 9.0)
  assert.equal(item.year, '2018')
})

test('剧集被单独分到 tv 类别', () => {
  const raw = structuredClone(movieRaw)
  raw.subject.type = 'tv'
  const item = normalizeInterest(raw)
  assert.equal(item.category, 'tv')
  assert.equal(item.key, 'tv:26752088')
})

test('图书条目', () => {
  const raw = structuredClone(movieRaw)
  raw.subject.type = 'book'
  const item = normalizeInterest(raw)
  assert.equal(item.category, 'book')
})

test('缺少我的评分与短评时不产生占位值', () => {
  const raw = structuredClone(movieRaw)
  raw.rating = { value: null }
  delete raw.comment
  const item = normalizeInterest(raw)
  assert.equal(item.myRating, undefined)
  assert.equal(item.myComment, undefined)
})

test('缺少豆瓣评分时为 undefined', () => {
  const raw = structuredClone(movieRaw)
  raw.subject.rating.value = 0
  const item = normalizeInterest(raw)
  assert.equal(item.doubanRating, undefined)
})

test('没有 subject.id 的条目被丢弃', () => {
  assert.equal(normalizeInterest({ subject: {} }), null)
  assert.equal(normalizeInterest({}), null)
})

test('归一化会按 key 去重', () => {
  const dup = structuredClone(movieRaw)
  const out = normalizeInterests([movieRaw, dup])
  assert.equal(out.length, 1)
})

test('未知 type 落到 movie', () => {
  assert.equal(categoryOf({ type: 'unknown' }), 'movie')
  assert.equal(categoryOf(undefined), 'movie')
})
