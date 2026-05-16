#pragma once

#include <M5Unified.h>
#include <stdint.h>

enum class HeadroomExpression {
  Neutral,
  Listening,
  Speaking,
  Permission,
  Success,
  Failed,
  Thinking,
};

struct HeadroomFaceState {
  HeadroomExpression expression = HeadroomExpression::Neutral;
  float mouthOpen = 0.0f;
  float gazeX = 0.0f;
  float gazeY = 0.0f;
  uint16_t accentColor = TFT_SKYBLUE;
  bool connected = false;
};

class HeadroomFaceRenderer {
public:
  void begin(uint16_t width = 128, uint16_t height = 128, int rotationDegrees = 0);
  void setRotationDegrees(int rotationDegrees);
  void draw(const HeadroomFaceState& state);

private:
  M5Canvas canvas_{&M5.Display};
  uint16_t width_ = 128;
  uint16_t height_ = 128;
  int rotationDegrees_ = 0;

  // Randomized blink scheduling (lifelike, not a fixed loop).
  bool blinkSeeded_ = false;
  uint32_t nextBlinkAtMs_ = 0;
  void scheduleNextBlink(uint32_t nowMs);
  float blinkOpenAmount(uint32_t nowMs);

  void drawHeadBase(const HeadroomFaceState& state);
  void drawBrows(const HeadroomFaceState& state);
  void drawEyes(const HeadroomFaceState& state);
  void drawClosedEyeArc(int centerX, int eyeCenterY, uint16_t color);
  void drawMouth(const HeadroomFaceState& state);
  uint16_t backgroundFor(const HeadroomFaceState& state) const;
  uint16_t accentFor(const HeadroomFaceState& state) const;
};
