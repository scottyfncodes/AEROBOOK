import { isTask, taskLabel, taskText } from './tasks';

describe('tasks', () => {
  it('reads a follow-up recorded before there were kinds as a plain follow-up', () => {
    expect(taskLabel(undefined)).toBe('Follow up');
    expect(taskText({ note: '' })).toBe('Follow up');
    expect(taskText({ note: 'Check availability' })).toBe('Check availability');
  });

  it('puts what to do ahead of the note', () => {
    expect(taskText({ kind: 'quote', note: 'Hull and liability' })).toBe('Send quote — Hull and liability');
    expect(taskText({ kind: 'contract', note: '  ' })).toBe('Send contract');
    expect(taskText({ kind: 'call', note: '' })).toBe('Call');
  });

  it('leaves Other to the note', () => {
    expect(taskText({ kind: 'other', note: 'Pick up logbooks' })).toBe('Pick up logbooks');
    expect(taskText({ kind: 'other', note: '' })).toBe('Other');
  });

  it('tells an assigned task from a follow-up someone set themselves', () => {
    expect(isTask({ assignedBy: 'usr_1' })).toBe(true);
    expect(isTask({})).toBe(false);
    expect(isTask({ assignedBy: null })).toBe(false);
  });
});
