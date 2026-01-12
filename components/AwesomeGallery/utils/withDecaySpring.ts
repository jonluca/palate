import type { WithDecayConfig } from "react-native-reanimated";
import { defineAnimation } from "react-native-reanimated";

interface DecayAnimationState {
  current: number;
  velocity: number;
  lastTimestamp: number;
  moveBack?: boolean;
  toValue?: number;
  startTime?: number;
}

const MIN_VELOCITY = 80;
const SNAP_DURATION = 200; // ms for snapping back to bounds

export function withDecaySpring(
  userConfig: WithDecayConfig & { clamp: [number, number] },
  callback?: (finished?: boolean) => void,
) {
  "worklet";

  return defineAnimation(0, () => {
    "worklet";
    const config = {
      deceleration: 0.997,
      restDisplacementThreshold: 0.5,
      restSpeedThreshold: 4,
      clamp: userConfig.clamp,
      velocity: userConfig.velocity,
    };

    const VELOCITY_EPS = 1;

    function decayAnimation(animation: DecayAnimationState, now: number) {
      const { lastTimestamp, current, velocity } = animation;

      const deltaTime = Math.min(now - lastTimestamp, 64);
      animation.lastTimestamp = now;

      // If we're snapping back to bounds, use simple linear interpolation
      if (animation.moveBack && animation.toValue !== undefined && animation.startTime !== undefined) {
        const elapsed = now - animation.startTime;
        const progress = Math.min(elapsed / SNAP_DURATION, 1);
        // Use ease-out curve for smooth deceleration
        const easeOut = 1 - Math.pow(1 - progress, 3);

        animation.current = animation.toValue + (current - animation.toValue) * (1 - easeOut);

        if (progress >= 1) {
          animation.current = animation.toValue;
          return true;
        }

        // Simple linear interpolation toward target
        const distance = animation.toValue - current;
        const step = distance * 0.15; // Move 15% closer each frame
        animation.current = current + step;
        animation.velocity = 0;

        if (Math.abs(animation.toValue - animation.current) < config.restDisplacementThreshold) {
          animation.current = animation.toValue;
          return true;
        }

        return false;
      }

      // Standard decay physics
      const kv = Math.pow(config.deceleration, deltaTime);
      const kx = (config.deceleration * (1 - kv)) / (1 - config.deceleration);

      const v0 = velocity / 1000;
      const v = v0 * kv * 1000;
      const nextX = current + v0 * kx;

      // Check if we've hit the bounds
      if (Array.isArray(config.clamp)) {
        if (nextX < config.clamp[0] || nextX > config.clamp[1]) {
          if (!animation.moveBack) {
            animation.moveBack = true;
            animation.startTime = now;
            animation.toValue = nextX <= config.clamp[0] ? config.clamp[0] : config.clamp[1];
          }
          return false;
        }
      }

      animation.current = nextX;
      animation.velocity = v;

      return Math.abs(v) < VELOCITY_EPS;
    }

    function onStart(animation: DecayAnimationState, value: number, now: number) {
      animation.current = value;
      animation.lastTimestamp = now;
    }

    return {
      onFrame: decayAnimation,
      onStart,
      velocity: Math.abs(config.velocity || 0) > MIN_VELOCITY ? config.velocity : 0,
      callback,
    };
  });
}
