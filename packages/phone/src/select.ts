/** Exercise the same accessible, portaled picker as keyboard and pointer users. */
import type { Page } from 'puppeteer-core';

export async function chooseSelect(
  page: Page,
  scope: string,
  value: string,
  context = 'select',
): Promise<void> {
  const triggers = await page.$$(`${scope} .select-trigger[role="combobox"]`);
  for (const trigger of triggers) {
    if (!(await trigger.evaluate((element) => element.getClientRects().length > 0))) continue;
    const before = await trigger.evaluate((element) => element.getAttribute('data-value'));
    let menuId: string | null = null;
    let stage = 'open';
    let beforeClick: unknown = null;
    const diagnostic = await page
      .evaluateHandle(
        (element: Element, wanted: string) => {
          const events: {
            type: string;
            pointerType: string | null;
            owner: string;
            expanded: string | null;
            current: string | null;
            clientX: number | null;
            clientY: number | null;
            geometry: ({
              left: number;
              top: number;
              right: number;
              bottom: number;
              scrollLeft: number;
              scrollTop: number;
            } | null)[];
          }[] = [];
          let moves = 0;
          const observe = (event: Event) => {
            if (events.length >= 24) return;
            if (event.type === 'pointermove' && ++moves > 8) return;
            const target = event.target;
            const id = element.getAttribute('aria-controls');
            const menu = id ? document.getElementById(id) : null;
            const option = [...(menu?.querySelectorAll('[role="option"]') ?? [])].find(
              (item) => item.getAttribute('data-value') === wanted,
            );
            const modal = element.closest('[role="dialog"]');
            const geometry = [menu, option, modal].map((node) => {
              if (!node) return null;
              const rect = node.getBoundingClientRect();
              return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                scrollLeft: node.scrollLeft,
                scrollTop: node.scrollTop,
              };
            });
            const owner =
              target instanceof Node && element.contains(target)
                ? 'trigger'
                : target instanceof Element && menu?.contains(target)
                  ? target.closest('[role="option"]')
                    ? 'owned-option'
                    : 'owned-menu'
                  : 'outside';
            events.push({
              type: event.type,
              pointerType: event instanceof PointerEvent ? event.pointerType : null,
              owner,
              expanded: element.getAttribute('aria-expanded'),
              current: element.getAttribute('data-value'),
              clientX: event instanceof MouseEvent ? event.clientX : null,
              clientY: event instanceof MouseEvent ? event.clientY : null,
              geometry,
            });
          };
          const types = ['pointermove', 'pointerdown', 'pointerup', 'click'];
          for (const type of types)
            document.addEventListener(type, observe, { capture: true, passive: true });
          return {
            events,
            stop: () => {
              for (const type of types) document.removeEventListener(type, observe, true);
            },
          };
        },
        trigger,
        value,
      )
      .catch(() => null);
    try {
      await trigger.click();
      await page.waitForFunction(
        (element: Element) => {
          const id = element.getAttribute('aria-controls');
          const menu = id ? document.getElementById(id) : null;
          return menu?.getAttribute('role') === 'listbox' && menu.getClientRects().length > 0;
        },
        {},
        trigger,
      );
      menuId = await trigger.evaluate((element) => element.getAttribute('aria-controls'));
      stage = 'option-ready';
      const options = await page.evaluateHandle(
        (id: string | null, target: string) => {
          const menu = id ? document.getElementById(id) : null;
          return (
            [...(menu?.querySelectorAll('[role="option"]') ?? [])].find(
              (element) => element.getAttribute('data-value') === target,
            ) ?? null
          );
        },
        menuId,
        value,
      );
      const node = options.asElement();
      if (!node) {
        await options.dispose();
        await page.keyboard.press('Escape');
        continue;
      }
      // Radix Select's Item renders a div; validate it rather than casting Node.
      const option = await node.toElement('div');
      try {
        await option.scrollIntoView();
        await page.waitForFunction(
          (element: Element, id: string | null) => {
            const menu = id ? document.getElementById(id) : null;
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return (
              element.isConnected &&
              menu?.contains(element) &&
              element.getAttribute('aria-disabled') !== 'true' &&
              rect.width > 0 &&
              rect.height > 0 &&
              hit !== null &&
              element.contains(hit)
            );
          },
          {},
          option,
          menuId,
        );
        beforeClick = await option
          .evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return {
              connected: element.isConnected,
              hitOwned: Boolean(hit && element.contains(hit)),
              disabled: element.getAttribute('aria-disabled'),
              // Same fixed [menu, requested option, owning modal] projection as delivery events.
              geometry: [
                element.closest('[role="listbox"]'),
                element,
                element.closest('[role="dialog"]'),
              ].map((node) => {
                if (!node) return null;
                const bounds = node.getBoundingClientRect();
                return {
                  left: bounds.left,
                  top: bounds.top,
                  right: bounds.right,
                  bottom: bounds.bottom,
                  scrollLeft: node.scrollLeft,
                  scrollTop: node.scrollTop,
                };
              }),
            };
          })
          .catch(() => null);
        stage = 'native-click';
        await option.click();
        stage = 'closed';
        await page.waitForFunction(
          (id: string | null) => {
            const menu = id ? document.getElementById(id) : null;
            return !menu || menu.getClientRects().length === 0;
          },
          {},
          menuId,
        );
        stage = 'commit';
        // Closing the owning portal is not proof the controlled value committed.
        await page.waitForFunction(
          (element: Element, target: string) =>
            element.isConnected && element.getAttribute('data-value') === target,
          {},
          trigger,
          value,
        );
        return;
      } finally {
        await options.dispose();
      }
    } catch (error) {
      const events = await diagnostic?.evaluate((data) => data.events).catch(() => null);
      const state = await trigger
        .evaluate(
          (element, id, target) => {
            const menu = id ? document.getElementById(id) : null;
            const option = [...(menu?.querySelectorAll('[role="option"]') ?? [])].find(
              (item) => item.getAttribute('data-value') === target,
            );
            const rect = option?.getBoundingClientRect();
            const hit = rect
              ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              : null;
            return {
              width: innerWidth,
              theme: localStorage.getItem('omr.theme'),
              triggerId: element.id,
              triggerLabel: element.getAttribute('aria-label'),
              connected: element.isConnected,
              current: element.getAttribute('data-value'),
              menuId: id,
              menuPresent: Boolean(menu),
              optionPresent: Boolean(option),
              optionDisabled: option?.getAttribute('aria-disabled') ?? null,
              optionHit: Boolean(option && hit && option.contains(hit)),
            };
          },
          menuId,
          value,
        )
        .catch(() => ({ diagnosticUnavailable: true }));
      throw new Error(
        `Select failed: ${context} ${JSON.stringify({ scope, target: value, before, stage, beforeClick, events, ...state })}`,
        { cause: error },
      );
    } finally {
      if (diagnostic) {
        await diagnostic.evaluate((data) => data.stop()).catch(() => undefined);
        await diagnostic.dispose().catch(() => undefined);
      }
    }
  }
  throw new Error(`Select option missing: ${value} in ${scope} (${context})`);
}
