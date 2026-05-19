#include "face_renderer.h"

#include <algorithm>
#include <esp_random.h>
#include <math.h>

namespace {

float clampFloat(float value, float minValue, float maxValue) {
  return std::max(minValue, std::min(value, maxValue));
}

int displayRotationForDegrees(int degrees) {
  int normalized = ((degrees % 360) + 360) % 360;
  switch (normalized) {
    case 90:
      return 1;
    case 180:
      return 2;
    case 270:
      return 3;
    default:
      return 0;
  }
}

// Shift the whole composed face downward by this many pixels. The head art is
// geometrically centered, but the hair adds visual weight up top, so nudging
// everything down makes the head look centered. The bottom rows clipped by the
// offset are background-only (head art ends well above the screen edge).
constexpr int kFaceOffsetY = 4;

void drawThickLine(M5Canvas& canvas, int x0, int y0, int x1, int y1, uint16_t color) {
  for (int offset = -2; offset <= 2; ++offset) {
    canvas.drawLine(x0, y0 + offset, x1, y1 + offset, color);
  }
}

}  // namespace

void HeadroomFaceRenderer::scheduleNextBlink(uint32_t nowMs) {
  // Random gap of 3 / 4 / 5 s, but 1 in 10 times a quick 0.3 s re-blink.
  uint32_t gap;
  if ((esp_random() % 10u) == 0u) {
    gap = 300;
  } else {
    static const uint32_t gaps[3] = {3000, 4000, 5000};
    gap = gaps[esp_random() % 3u];
  }
  nextBlinkAtMs_ = nowMs + gap;
}

float HeadroomFaceRenderer::blinkOpenAmount(uint32_t nowMs) {
  if (!blinkSeeded_) {
    blinkSeeded_ = true;
    scheduleNextBlink(nowMs);
  }
  if (nowMs < nextBlinkAtMs_) {
    return 1.0f;
  }
  uint32_t phase = nowMs - nextBlinkAtMs_;
  if (phase >= 160) {
    scheduleNextBlink(nowMs);
    return 1.0f;
  }
  if (phase < 60) {
    return 1.0f - static_cast<float>(phase) / 60.0f;
  }
  if (phase < 100) {
    return 0.0f;
  }
  return static_cast<float>(phase - 100) / 60.0f;
}

void HeadroomFaceRenderer::begin(uint16_t width, uint16_t height, int rotationDegrees) {
  width_ = width;
  height_ = height;
  canvas_.setColorDepth(16);
  canvas_.createSprite(width_, height_);
  setRotationDegrees(rotationDegrees);
  canvas_.setTextDatum(middle_center);
  canvas_.setTextSize(1);
}

void HeadroomFaceRenderer::setRotationDegrees(int rotationDegrees) {
  rotationDegrees_ = rotationDegrees;
  M5.Display.setRotation(displayRotationForDegrees(rotationDegrees_));
}

void HeadroomFaceRenderer::draw(const HeadroomFaceState& state) {
  uint16_t background = backgroundFor(state);
  canvas_.startWrite();
  canvas_.fillScreen(background);
  drawHeadBase(state);
  drawBrows(state);
  drawEyes(state);
  drawMouth(state);

  if (!state.connected) {
    canvas_.drawCircle(width_ - 10, 10, 3, canvas_.color565(105, 112, 120));
  } else {
    canvas_.fillCircle(width_ - 10, 10, 3, TFT_GREEN);
  }
  canvas_.endWrite();
  // Clear the strip exposed above the shifted sprite, then push it down.
  if (kFaceOffsetY > 0) {
    M5.Display.fillRect(0, 0, width_, kFaceOffsetY, background);
  }
  canvas_.pushSprite(0, kFaceOffsetY);
}

void HeadroomFaceRenderer::drawHeadBase(const HeadroomFaceState& state) {
  uint16_t skin = canvas_.color565(255, 201, 150);
  uint16_t cheek = canvas_.color565(255, 184, 132);
  uint16_t hair = canvas_.color565(178, 112, 56);
  uint16_t hairShadow = canvas_.color565(132, 78, 40);
  uint16_t outline = canvas_.color565(168, 105, 63);

  canvas_.fillRoundRect(13, 14, 102, 100, 31, outline);
  canvas_.fillRoundRect(16, 16, 96, 96, 29, skin);
  canvas_.drawRoundRect(16, 16, 96, 96, 29, outline);
  canvas_.fillRoundRect(22, 16, 84, 22, 13, hairShadow);
  canvas_.fillRoundRect(20, 15, 88, 20, 12, hair);
  canvas_.fillCircle(29, 32, 11, hair);
  canvas_.fillCircle(45, 24, 14, hair);
  canvas_.fillCircle(64, 21, 16, hair);
  canvas_.fillCircle(84, 24, 14, hair);
  canvas_.fillCircle(100, 32, 11, hair);
  canvas_.fillTriangle(29, 34, 42, 35, 34, 43, hair);
  canvas_.fillTriangle(56, 31, 69, 31, 62, 42, hair);
  canvas_.fillTriangle(85, 34, 99, 34, 91, 43, hair);
  canvas_.fillEllipse(37, 82, 10, 6, cheek);
  canvas_.fillEllipse(91, 82, 10, 6, cheek);
}

void HeadroomFaceRenderer::drawBrows(const HeadroomFaceState& state) {
  uint16_t color = canvas_.color565(93, 55, 31);
  int leftY = 45;
  int rightY = 45;
  int slant = 0;

  switch (state.expression) {
    case HeadroomExpression::Permission:
      color = canvas_.color565(112, 72, 28);
      leftY = 42;
      rightY = 42;
      slant = 5;
      break;
    case HeadroomExpression::Failed:
      color = canvas_.color565(110, 42, 31);
      slant = -6;
      break;
    case HeadroomExpression::Success:
      // Raised happy "\/" brows (inverse of への字), lifted slightly higher.
      // Same brown as the normal brows for consistency.
      leftY = 40;
      rightY = 40;
      slant = -5;
      break;
    case HeadroomExpression::Thinking:
      color = canvas_.color565(71, 63, 41);
      leftY = 45;
      rightY = 45;
      slant = 5;
      break;
    case HeadroomExpression::Listening:
      color = canvas_.color565(102, 61, 30);
      leftY = 45;
      rightY = 45;
      break;
    default:
      break;
  }

  drawThickLine(canvas_, 32, leftY + slant, 53, leftY - slant, color);
  drawThickLine(canvas_, 75, rightY - slant, 96, rightY + slant, color);
}

void HeadroomFaceRenderer::drawClosedEyeArc(int centerX, int eyeCenterY, uint16_t color) {
  // Downward-convex "∪" eyelid arc (a dark lash line), not a white sliver.
  // Larger radius + narrower sweep = a gentler, flatter curve; the slightly
  // smaller upward offset drops the whole arc a touch lower on the face.
  const int radius = 19;
  const int arcCenterY = eyeCenterY - 16;  // a little lower than before
  canvas_.fillArc(centerX, arcCenterY, radius, radius - 4, 45.0f, 135.0f, color);
}

void HeadroomFaceRenderer::drawEyes(const HeadroomFaceState& state) {
  int pupilOffsetX = static_cast<int>(roundf(clampFloat(state.gazeX, -1.0f, 1.0f) * 3.0f));
  int pupilOffsetY = static_cast<int>(roundf(clampFloat(state.gazeY, -1.0f, 1.0f) * 2.0f));

  // Thinking: sweep the eyes slowly left/right like the PC/mobile face.
  if (state.expression == HeadroomExpression::Thinking) {
    float t = static_cast<float>(millis()) / 1000.0f;
    pupilOffsetX = static_cast<int>(roundf(sinf(t * 1.6f) * 4.0f));
    pupilOffsetY = 0;
  }

  int eyeY = 54;
  int pupilY = 64;
  const int leftCenterX = 42;
  const int rightCenterX = 85;

  int eyeHeight = 20;
  if (state.expression == HeadroomExpression::Thinking) {
    eyeHeight = 17;
  }

  float blink = blinkOpenAmount(millis());
  uint16_t lidColor = canvas_.color565(70, 42, 26);

  // Closed (blink): draw the dark ∪ eyelid arc instead of a white bar.
  if (blink <= 0.30f) {
    drawClosedEyeArc(leftCenterX, pupilY, lidColor);
    drawClosedEyeArc(rightCenterX, pupilY, lidColor);
    return;
  }

  eyeHeight = std::max(6, static_cast<int>(roundf(static_cast<float>(eyeHeight) * blink)));

  // Mid-blink: avoid the sclera-only frame by showing a closed eyelid until
  // there is enough height to include a pupil.
  if (eyeHeight < 10) {
    drawClosedEyeArc(leftCenterX, pupilY, lidColor);
    drawClosedEyeArc(rightCenterX, pupilY, lidColor);
    return;
  }

  uint16_t eyeOutline = canvas_.color565(120, 76, 45);
  canvas_.fillRoundRect(25, eyeY, 35, eyeHeight, 8, TFT_WHITE);
  canvas_.fillRoundRect(68, eyeY, 35, eyeHeight, 8, TFT_WHITE);
  canvas_.drawRoundRect(25, eyeY, 35, eyeHeight, 8, eyeOutline);
  canvas_.drawRoundRect(68, eyeY, 35, eyeHeight, 8, eyeOutline);

  const int currentPupilY = eyeY + (eyeHeight / 2);
  const int pupilRadius = std::max(3, std::min(5, eyeHeight / 3));
  uint16_t pupilColor = TFT_BLACK;
  if (state.expression == HeadroomExpression::Permission) {
    pupilColor = canvas_.color565(5, 17, 54);
  }
  canvas_.fillCircle(leftCenterX + pupilOffsetX, currentPupilY + pupilOffsetY, pupilRadius, pupilColor);
  canvas_.fillCircle(rightCenterX + pupilOffsetX, currentPupilY + pupilOffsetY, pupilRadius, pupilColor);

  uint16_t catchlight = TFT_WHITE;
  canvas_.fillCircle(leftCenterX + pupilOffsetX - 2, currentPupilY + pupilOffsetY - 2, 1, catchlight);
  canvas_.fillCircle(rightCenterX + pupilOffsetX - 2, currentPupilY + pupilOffsetY - 2, 1, catchlight);
}

void HeadroomFaceRenderer::drawMouth(const HeadroomFaceState& state) {
  float open = clampFloat(state.mouthOpen, 0.0f, 1.0f);
  uint16_t mouthColor = canvas_.color565(116, 32, 28);
  uint16_t mouthInnerColor = canvas_.color565(72, 20, 24);

  switch (state.expression) {
    case HeadroomExpression::Failed:
      drawThickLine(canvas_, 50, 94, 64, 86, mouthColor);
      drawThickLine(canvas_, 64, 86, 78, 94, mouthColor);
      return;
    case HeadroomExpression::Permission:
      canvas_.drawRoundRect(51, 84, 27, 18, 7, mouthColor);
      canvas_.drawRoundRect(52, 85, 25, 16, 6, mouthColor);
      return;
    case HeadroomExpression::Listening:
      canvas_.drawCircle(64, 92, 10, mouthColor);
      canvas_.drawCircle(64, 92, 11, mouthColor);
      return;
    case HeadroomExpression::Success:
      // While speaking, keep the talking mouth animation (口パク).
      // When the mouth is closed and status is success, show the smile arc.
      if (open <= 0.12f) {
        canvas_.fillArc(64, 82, 18, 13, 20.0f, 160.0f, mouthColor);
        return;
      }
      break;
    default:
      break;
  }

  int mouthHeight = 3 + static_cast<int>(roundf(open * 24.0f));
  int mouthWidth = 34 + static_cast<int>(roundf(open * 12.0f));
  int x = (width_ - mouthWidth) / 2;

  if (mouthHeight <= 5) {
    canvas_.drawRoundRect(x, 88, mouthWidth, 5, 3, mouthColor);
    canvas_.drawRoundRect(x, 89, mouthWidth, 5, 3, mouthColor);
  } else {
    canvas_.fillEllipse(width_ / 2, 91, mouthWidth / 2, mouthHeight / 2, mouthColor);
    canvas_.fillEllipse(width_ / 2, 91, std::max(4, mouthWidth / 3), std::max(2, mouthHeight / 3), mouthInnerColor);
  }
}

uint16_t HeadroomFaceRenderer::backgroundFor(const HeadroomFaceState& state) const {
  switch (state.expression) {
    case HeadroomExpression::Listening:
      return canvas_.color565(72, 44, 24);
    case HeadroomExpression::Speaking:
      return canvas_.color565(20, 62, 78);
    case HeadroomExpression::Permission:
      return canvas_.color565(82, 48, 24);
    case HeadroomExpression::Success:
      return canvas_.color565(22, 76, 58);
    case HeadroomExpression::Failed:
      return canvas_.color565(82, 34, 34);
    case HeadroomExpression::Thinking:
      return canvas_.color565(19, 48, 67);
    default:
      return canvas_.color565(13, 26, 38);
  }
}

uint16_t HeadroomFaceRenderer::accentFor(const HeadroomFaceState& state) const {
  switch (state.expression) {
    case HeadroomExpression::Listening:
      return TFT_ORANGE;
    case HeadroomExpression::Speaking:
      return TFT_SKYBLUE;
    case HeadroomExpression::Permission:
      return TFT_YELLOW;
    case HeadroomExpression::Success:
      return TFT_GREEN;
    case HeadroomExpression::Failed:
      return TFT_RED;
    case HeadroomExpression::Thinking:
      return TFT_CYAN;
    default:
      return state.accentColor;
  }
}
