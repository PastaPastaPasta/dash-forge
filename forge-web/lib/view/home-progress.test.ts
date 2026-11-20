import { describe, expect, it } from 'vitest'
import { homeStage, startHomeStages } from './home-progress'

describe('home read steps', () => {
  it('starts on the first step, moves forward only, and keeps the last after it ends', () => {
    const report = startHomeStages('a')
    expect(homeStage('a')).toBe('owner')
    report('refs')
    report('owner')
    expect(homeStage('a')).toBe('refs')
  })

  it('lets only the latest read under a key report', () => {
    const first = startHomeStages('b')
    const second = startHomeStages('b')
    first('refs')
    expect(homeStage('b')).toBe('owner')
    second('repo')
    expect(homeStage('b')).toBe('repo')
  })
})
