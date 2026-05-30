import { describe, expect, test } from 'vitest'
import { fs_get_breadcrumbs } from '../../../desktop/sidebar-utils'

describe(`fs_get_breadcrumbs`, () => {
  test(`keeps Windows drive paths valid when they use forward slashes`, () => {
    expect(fs_get_breadcrumbs(`E:/Projects/example/data`)).toEqual([
      { label: `E:`, path: `E:/` },
      { label: `Projects`, path: `E:/Projects/` },
      { label: `example`, path: `E:/Projects/example/` },
      { label: `data`, path: `E:/Projects/example/data/` },
    ])
  })

  test(`keeps Windows drive paths valid when they use backslashes`, () => {
    expect(fs_get_breadcrumbs(`E:\\Projects\\example\\data`)).toEqual([
      { label: `E:`, path: `E:\\` },
      { label: `Projects`, path: `E:\\Projects\\` },
      { label: `example`, path: `E:\\Projects\\example\\` },
      { label: `data`, path: `E:\\Projects\\example\\data\\` },
    ])
  })

  test(`normalizes Windows verbatim drive prefixes`, () => {
    expect(fs_get_breadcrumbs(`\\\\?\\E:\\Projects\\example\\data`)).toEqual([
      { label: `E:`, path: `E:\\` },
      { label: `Projects`, path: `E:\\Projects\\` },
      { label: `example`, path: `E:\\Projects\\example\\` },
      { label: `data`, path: `E:\\Projects\\example\\data\\` },
    ])
  })

  test(`keeps Unix paths rooted at slash`, () => {
    expect(fs_get_breadcrumbs(`/var/tmp/data`)).toEqual([
      { label: `/`, path: `/` },
      { label: `var`, path: `/var` },
      { label: `tmp`, path: `/var/tmp` },
      { label: `data`, path: `/var/tmp/data` },
    ])
  })
})
