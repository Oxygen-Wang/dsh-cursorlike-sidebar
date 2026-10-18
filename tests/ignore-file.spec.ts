// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { IGNORE_FILE, IGNORE_PATTERN_LIMIT, appendIgnorePatterns, parseIgnoreFile } from '../src/client/ignore-file.ts'

describe('parseIgnoreFile', () => {
  it('reads the workspace .ignore name', () => {
    expect(IGNORE_FILE).toBe('.ignore')
  })

  it('keeps positive patterns in file order across CRLF and LF', () => {
    const patterns = parseIgnoreFile([
      '# dependencies',
      'node_modules/',
      '',
      '  dist/  ',
      '*.log',
      '!keep.log',
      '**/.cache',
    ].join('\r\n'))
    expect(patterns).toEqual(['node_modules/', 'dist/', '*.log', '**/.cache'])
  })

  it('skips comments and negation instead of turning them into literals', () => {
    expect(parseIgnoreFile('# comment\n!important.log\n\nfoo')).toEqual(['foo'])
  })

  it('caps the list at the host-compatible limit', () => {
    const patterns = Array.from({ length: IGNORE_PATTERN_LIMIT + 20 }, (_, at) => `dir-${at}/`)
    expect(parseIgnoreFile(patterns.join('\n'))).toHaveLength(IGNORE_PATTERN_LIMIT)
  })
})

describe('appendIgnorePatterns', () => {
  it('keeps comments, avoids duplicates and appends with a trailing newline', () => {
    expect(appendIgnorePatterns('# deps\nnode_modules/\n', ['dist/', 'node_modules/'])).toBe(
      '# deps\nnode_modules/\ndist/\n',
    )
  })

  it('creates a new file body when .ignore does not exist', () => {
    expect(appendIgnorePatterns('', ['*.log', 'secret/'])).toBe('*.log\nsecret/\n')
  })

  it('returns the same content when every pattern is already there', () => {
    expect(appendIgnorePatterns('dist/\n', ['dist/'])).toBe('dist/\n')
  })
})
