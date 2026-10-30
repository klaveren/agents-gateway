import { describe, expect, it } from 'vitest'
import { fixPattern, patternWarning } from './permissions'

describe('regra de terminal com **', () => {
  it('avisa no terminal e troca cada ** solto por *; caminho com ** não é tocado', () => {
    expect(patternWarning({ category: 'terminal', pattern: '**', decision: 'allow' })).toMatch(/use \*/)
    expect(patternWarning({ category: 'terminal', pattern: 'git **', decision: 'allow' })).toBeDefined()
    expect(patternWarning({ category: 'terminal', pattern: 'git *', decision: 'allow' })).toBeUndefined()
    expect(patternWarning({ category: 'read', pattern: 'apps/**', decision: 'allow' })).toBeUndefined()
    expect(fixPattern('**')).toBe('*')
    expect(fixPattern('git ** --force')).toBe('git * --force')
    expect(fixPattern('ls *.ts')).toBe('ls *.ts')
  })
})
