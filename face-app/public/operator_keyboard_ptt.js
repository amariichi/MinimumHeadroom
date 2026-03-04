export const OPERATOR_KEYBOARD_PTT_TARGET_SELECTOR =
  "input,textarea,select,[contenteditable=''],[contenteditable='true'],[contenteditable='plaintext-only']";
export const OPERATOR_KEYBOARD_COMMAND_BLOCKED_SELECTOR =
  "button,input,select,textarea,label,a,[role='button'],[contenteditable=''],[contenteditable='true'],[contenteditable='plaintext-only']";

export function isOperatorKeyboardPttBlockedTarget(
  target,
  textInputElement = null,
  selector = OPERATOR_KEYBOARD_PTT_TARGET_SELECTOR
) {
  if (!target || typeof target.closest !== 'function') {
    return false;
  }
  const blocked = target.closest(selector);
  return blocked !== null && blocked !== textInputElement;
}

export function isOperatorKeyboardCommandBlockedTarget(
  target,
  textInputElement = null,
  selector = OPERATOR_KEYBOARD_COMMAND_BLOCKED_SELECTOR
) {
  if (!target || typeof target.closest !== 'function') {
    return false;
  }
  const blocked = target.closest(selector);
  return blocked !== null && blocked !== textInputElement;
}

export function resolveOperatorKeyboardPttLanguage(event, { isMobileUi = false, textInputElement = null } = {}) {
  void isMobileUi;
  if (!event || event.repeat) {
    return null;
  }
  if (isOperatorKeyboardPttBlockedTarget(event.target, textInputElement)) {
    return null;
  }
  if (event.metaKey) {
    return null;
  }

  if (event.key === 'Control') {
    if (event.altKey || event.shiftKey) {
      return null;
    }
    return 'ja';
  }

  if (event.key === 'Alt') {
    if (event.ctrlKey || event.shiftKey) {
      return null;
    }
    return 'en';
  }

  const isSpaceKey = event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space';
  if (isSpaceKey) {
    if (event.ctrlKey || event.altKey) {
      return null;
    }
    return event.shiftKey ? 'en' : 'ja';
  }

  return null;
}

export function resolveOperatorKeyboardCommandAction(event, { textInputElement = null } = {}) {
  if (!event || event.repeat || event.isComposing || event.defaultPrevented) {
    return null;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) {
    if (!event.altKey && !event.metaKey && event.ctrlKey && event.shiftKey && (event.key === 'Shift' || event.key === 'Control')) {
      return 'focus_text_input';
    }
    return null;
  }

  if (event.key === 'Backspace') {
    if (event.shiftKey) {
      return null;
    }
    if (isOperatorKeyboardCommandBlockedTarget(event.target, null)) {
      return null;
    }
    return 'clear_text';
  }

  if (event.key === 'PageUp' || event.key === 'PageDown') {
    if (event.shiftKey) {
      return null;
    }
    if (isOperatorKeyboardCommandBlockedTarget(event.target, null)) {
      return null;
    }
    return event.key === 'PageUp' ? 'mirror_page_up' : 'mirror_page_down';
  }

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    if (event.shiftKey) {
      return null;
    }
    if (isOperatorKeyboardCommandBlockedTarget(event.target, textInputElement)) {
      return null;
    }
    return event.key === 'ArrowUp' ? 'select_up' : 'select_down';
  }

  if (event.key !== 'Enter') {
    return null;
  }

  if (isOperatorKeyboardCommandBlockedTarget(event.target, textInputElement)) {
    return null;
  }

  return event.shiftKey ? 'send_text' : 'select';
}
