import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isOperatorKeyboardCommandBlockedTarget,
  isOperatorKeyboardPttBlockedTarget,
  resolveOperatorKeyboardCommandAction,
  resolveOperatorKeyboardPttLanguage
} from '../../face-app/public/operator_keyboard_ptt.js';

test('keyboard PTT maps Control to JA on desktop', () => {
  assert.equal(
    resolveOperatorKeyboardPttLanguage({
      key: 'Control',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'ja'
  );
});

test('keyboard PTT maps Alt to EN on desktop', () => {
  assert.equal(
    resolveOperatorKeyboardPttLanguage({
      key: 'Alt',
      ctrlKey: false,
      altKey: true,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'en'
  );
});

test('keyboard PTT maps Space to JA and Shift+Space to EN', () => {
  assert.equal(
    resolveOperatorKeyboardPttLanguage({
      key: ' ',
      code: 'Space',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'ja'
  );

  assert.equal(
    resolveOperatorKeyboardPttLanguage({
      key: ' ',
      code: 'Space',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: true,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'en'
  );
});

test('keyboard PTT ignores editable targets', () => {
  const target = {
    closest(selector) {
      return selector.includes('textarea') ? {} : null;
    }
  };

  assert.equal(isOperatorKeyboardPttBlockedTarget(target), true);
  assert.equal(
    resolveOperatorKeyboardPttLanguage({
      key: 'Control',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target
    }),
    null
  );
});

test('keyboard PTT allows the operator text input target when explicitly provided', () => {
  const textAreaTarget = {
    closest(selector) {
      return selector.includes('textarea') ? textAreaTarget : null;
    }
  };

  assert.equal(isOperatorKeyboardPttBlockedTarget(textAreaTarget, textAreaTarget), false);
  assert.equal(
    resolveOperatorKeyboardPttLanguage(
      {
        key: 'Control',
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        target: textAreaTarget
      },
      { textInputElement: textAreaTarget }
    ),
    'ja'
  );
});

test('keyboard PTT ignores modified combos that should remain reserved', () => {
  assert.equal(
    resolveOperatorKeyboardPttLanguage(
      {
        key: 'Control',
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        target: null
      }
    ),
    'ja'
  );

  assert.equal(
    resolveOperatorKeyboardPttLanguage({
      key: 'Control',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: true,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    null
  );

  assert.equal(
    resolveOperatorKeyboardPttLanguage({
      key: ' ',
      code: 'Space',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    null
  );
});

test('keyboard command maps Enter to select and Shift+Enter to send text', () => {
  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'select'
  );

  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'Enter',
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'send_text'
  );
});

test('keyboard command maps Backspace to clear text outside interactive controls', () => {
  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'Backspace',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'clear_text'
  );
});

test('keyboard command maps PageUp and PageDown to mirror scrolling', () => {
  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'PageUp',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'mirror_page_up'
  );

  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'PageDown',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'mirror_page_down'
  );
});

test('keyboard command maps ArrowUp and ArrowDown to operator selection', () => {
  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'ArrowUp',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'select_up'
  );

  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'ArrowDown',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'select_down'
  );
});

test('keyboard command maps Ctrl+Shift to focus text input', () => {
  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'Shift',
      shiftKey: true,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'focus_text_input'
  );

  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'Control',
      shiftKey: true,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null
    }),
    'focus_text_input'
  );
});

test('keyboard command ignores interactive controls except operator text input', () => {
  const buttonTarget = {
    closest(selector) {
      return selector.includes('button') ? { tagName: 'BUTTON' } : null;
    }
  };
  assert.equal(isOperatorKeyboardCommandBlockedTarget(buttonTarget, null), true);
  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: buttonTarget
    }),
    null
  );

  assert.equal(
    resolveOperatorKeyboardCommandAction({
      key: 'Backspace',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: buttonTarget
    }),
    null
  );

  const textAreaTarget = {
    closest(selector) {
      return selector.includes('textarea') ? textAreaTarget : null;
    }
  };
  assert.equal(isOperatorKeyboardCommandBlockedTarget(textAreaTarget, textAreaTarget), false);
  assert.equal(
    resolveOperatorKeyboardCommandAction(
      {
        key: 'Enter',
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        target: textAreaTarget
      },
      { textInputElement: textAreaTarget }
    ),
    'send_text'
  );

  assert.equal(
    resolveOperatorKeyboardCommandAction(
      {
        key: 'Backspace',
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        target: textAreaTarget
      },
      { textInputElement: textAreaTarget }
    ),
    null
  );

  assert.equal(
    resolveOperatorKeyboardCommandAction(
      {
        key: 'PageDown',
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        target: textAreaTarget
      },
      { textInputElement: textAreaTarget }
    ),
    null
  );

  assert.equal(
    resolveOperatorKeyboardCommandAction(
      {
        key: 'ArrowUp',
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        target: textAreaTarget
      },
      { textInputElement: textAreaTarget }
    ),
    'select_up'
  );
});
