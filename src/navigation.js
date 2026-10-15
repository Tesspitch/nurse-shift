const SCREENS = new Set(['home', 'calendar', 'settings']);
const ACTIONS = new Set(['add-shift']);

export function readNavigationIntent(search = '') {
  const params = new URLSearchParams(search);
  const screen = params.get('screen');
  const action = params.get('action');

  return {
    screen: SCREENS.has(screen) ? screen : null,
    action: ACTIONS.has(action) ? action : null
  };
}
