import { DynamicParallelism } from './dynamic-parallelism';

describe('DynamicParallelism', () => {
  const idle = { cpuUsage: 0.2, memoryAvailable: 0.6 };

  function create(initial: number, onChange = vi.fn()) {
    return {
      controller: new DynamicParallelism(
        { min: 1, max: 8, initial, sample: () => idle },
        onChange
      ),
      onChange,
    };
  }

  it('starts at half the ceiling by default', () => {
    expect(new DynamicParallelism({ max: 8 }).limit).toBe(4);
    expect(new DynamicParallelism({ max: 1 }).limit).toBe(1);
  });

  it('grows by one when there is headroom and every slot is taken', () => {
    const { controller, onChange } = create(4);
    expect(controller.adjust(idle, 4)).toBe(5);
    expect(onChange).toHaveBeenCalledWith(5, expect.any(String));
  });

  it('does not grow while slots are free', () => {
    const { controller, onChange } = create(4);
    expect(controller.adjust(idle, 3)).toBe(4);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not grow when memory is low', () => {
    const { controller } = create(4);
    expect(controller.adjust({ cpuUsage: 0.2, memoryAvailable: 0.15 }, 4)).toBe(
      4
    );
  });

  it('shrinks by one when CPUs are saturated', () => {
    const { controller } = create(4);
    expect(controller.adjust({ cpuUsage: 0.95, memoryAvailable: 0.6 }, 4)).toBe(
      3
    );
  });

  it('halves under memory pressure, even with idle CPUs', () => {
    const { controller } = create(8);
    expect(controller.adjust({ cpuUsage: 0.1, memoryAvailable: 0.05 }, 8)).toBe(
      4
    );
  });

  it('stays within min and max', () => {
    const { controller } = create(8);
    expect(controller.adjust(idle, 8)).toBe(8);

    const low = create(1).controller;
    expect(low.adjust({ cpuUsage: 1, memoryAvailable: 0.01 }, 1)).toBe(1);
  });
});
