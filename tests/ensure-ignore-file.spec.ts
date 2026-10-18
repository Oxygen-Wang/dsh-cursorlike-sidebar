import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureIgnoreFile } from '../src/client/ensure-ignore-file.ts'
const mocks = vi.hoisted(() => ({ fsRead: vi.fn(), fsCreateFile: vi.fn() }))
vi.mock('../src/client/api.ts', () => ({ api: mocks }))
const scope = { sessionId: 's', cwd: '/ws' }
beforeEach(() => { vi.resetAllMocks() })
describe('ensure .ignore before opening', () => {
  it('creates a missing file, then reads its version', async () => {
    mocks.fsRead.mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce({ kind: 'text', content: '', mtimeMs: 3 })
    mocks.fsCreateFile.mockResolvedValue({ path: '/ws/.ignore' })
    expect(await ensureIgnoreFile(scope)).toEqual({ content: '', mtimeMs: 3 })
    expect(mocks.fsCreateFile).toHaveBeenCalledWith(scope, '/ws', '.ignore')
  })
  it('preserves an existing file without creating or truncating it', async () => {
    mocks.fsRead.mockResolvedValue({ kind: 'text', content: '# rules\n*.log\n', mtimeMs: 2 })
    expect((await ensureIgnoreFile(scope)).content).toBe('# rules\n*.log\n')
    expect(mocks.fsCreateFile).not.toHaveBeenCalled()
  })
  it('does not treat permission failures as missing files', async () => {
    mocks.fsRead.mockRejectedValue(new Error('EACCES'))
    await expect(ensureIgnoreFile(scope)).rejects.toThrow('EACCES')
    expect(mocks.fsCreateFile).not.toHaveBeenCalled()
  })
  it('keeps rules created by another window during creation', async () => {
    mocks.fsRead.mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce({ kind: 'text', content: '*.tmp\n', mtimeMs: 4 })
    mocks.fsCreateFile.mockRejectedValue(new Error('EEXIST'))
    expect((await ensureIgnoreFile(scope)).content).toBe('*.tmp\n')
  })
})
