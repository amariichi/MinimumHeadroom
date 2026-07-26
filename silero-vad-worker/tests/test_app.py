from __future__ import annotations

import base64
import unittest

import numpy as np
import torch

from silero_vad_worker.app import VadRequest, create_app


class _FakeScalar:
    def __init__(self, value: float) -> None:
        self._value = value

    def item(self) -> float:
        return self._value


class _FakeModel:
    def __init__(self) -> None:
        self.calls = 0
        self.reset_count = 0

    def reset_states(self) -> None:
        self.reset_count += 1

    def to(self, _device: str) -> "_FakeModel":
        return self

    def __call__(self, tensor: torch.Tensor, _sample_rate: int) -> _FakeScalar:
        self.calls += 1
        probability = 0.9 if float(tensor.abs().mean()) > 0.01 else 0.1
        return _FakeScalar(probability)


def _pcm_base64(amplitude: int = 3000, samples: int = 1024) -> str:
    pcm = np.empty(samples, dtype=np.int16)
    pcm[0::2] = amplitude
    pcm[1::2] = -amplitude
    return base64.b64encode(pcm.tobytes()).decode("ascii")


class SileroVadWorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.models: list[_FakeModel] = []

        def loader() -> _FakeModel:
            model = _FakeModel()
            self.models.append(model)
            return model

        app = create_app(model_loader=loader, max_sessions=2)
        self.health = next(
            route.endpoint for route in app.routes if route.path == "/health"
        )
        self.vad = next(
            route.endpoint for route in app.routes if route.path == "/v1/vad"
        )

    def _post(
        self,
        *,
        session_id: str,
        stream_epoch: int = 0,
        generation: int = 0,
        sequence: int = 1,
        amplitude: int = 3000,
    ):
        return self.vad(
            VadRequest(
                audioBase64=_pcm_base64(amplitude),
                sampleRate=16000,
                threshold=0.5,
                sessionId=session_id,
                streamEpoch=stream_epoch,
                generation=generation,
                sequence=sequence,
            )
        )

    def test_health_reports_bounded_session_pool(self) -> None:
        response = self.health()
        self.assertEqual(response["activeSessions"], 0)
        self.assertEqual(response["maxSessions"], 2)

    def test_same_stream_reuses_state_and_epoch_change_resets_it(self) -> None:
        first = self._post(session_id="atom-a", sequence=1)
        second = self._post(session_id="atom-a", sequence=2)
        reset = self._post(session_id="atom-a", stream_epoch=1, sequence=3)

        self.assertTrue(first.stateReset)
        self.assertFalse(second.stateReset)
        self.assertTrue(reset.stateReset)
        self.assertEqual(len(self.models), 1)
        self.assertGreaterEqual(self.models[0].reset_count, 2)

    def test_sessions_are_isolated_and_pool_reuses_lru_model(self) -> None:
        a = self._post(session_id="atom-a")
        b = self._post(session_id="atom-b")
        c = self._post(session_id="atom-c")

        self.assertTrue(a.is_speech)
        self.assertTrue(b.is_speech)
        self.assertTrue(c.is_speech)
        self.assertEqual(len(self.models), 2)
        health = self.health()
        self.assertEqual(health["activeSessions"], 2)

    def test_response_echoes_stream_context_and_classifies_silence(self) -> None:
        response = self._post(
            session_id="atom-a",
            stream_epoch=3,
            generation=5,
            sequence=8,
            amplitude=0,
        )
        self.assertFalse(response.is_speech)
        self.assertEqual(response.sessionId, "atom-a")
        self.assertEqual(response.streamEpoch, 3)
        self.assertEqual(response.generation, 5)
        self.assertEqual(response.sequence, 8)


if __name__ == "__main__":
    unittest.main()
