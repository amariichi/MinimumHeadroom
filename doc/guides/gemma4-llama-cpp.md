# Gemma 4, GGUF, MTP, and llama.cpp

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

The interpreter's Gemma presets use Google's official Gemma 4 12B QAT
artifacts as the source of truth. Unsloth quantizations remain useful benchmark
candidates, but they are not mixed into the core setup unless their source
revision and main/projector/assistant compatibility are reviewed together. This
avoids silently missing a recent official model fix.

The checked-in provenance is
[`config/models/gemma4-interpreter.json`](../../config/models/gemma4-interpreter.json).

### Verified artifacts

| Role | Official source | Local filename | Bytes | SHA256 |
|---|---|---|---:|---|
| Main QAT Q4_0 | `google/gemma-4-12B-it-qat-q4_0-gguf` at `29d097773436b69ff9feafd636ab4cf873786537` | `gemma-4-12b-it-qat-q4_0.gguf` | 6,975,879,296 | `93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b` |
| Audio projector | same repository and revision | `mmproj-gemma-4-12b-it-qat-q4_0.gguf` | 175,115,616 | `cb018338a7538a9814d994bfe54644c71eb7ed54e31eae2f721e45fd3c260da7` |
| MTP assistant Q4_0 | `google/gemma-4-12B-it-qat-q4_0-unquantized-assistant` at `18934064dd4c5c6cc3621f6381e7d377fc8cb7bd` | `mtp-gemma-4-12B-it-qat-Q4_0.gguf` | 322,915,136 | `25f143b4c15b20cd04216e35e99bd7a56afc6f65e7a4e090a3e20091bb590cbb` |

The MTP file is not a planned placeholder. It is a verified conversion of the
official Google assistant safetensors, quantized to Q4_0. The source
`model.safetensors` was 845,719,296 bytes with SHA256
`67f1420cf24aa5065089aaed175223f7c245ccfda16111b6c56765afd7280db6`.
The build script recognizes the verified final file as reusable even if the
temporary Python environment used for the original conversion no longer exists.

### Higher-precision comparison candidates

Google currently publishes the ready-to-run 12B QAT GGUF only as Q4_0. The
normal `google/gemma-4-12B-it` repository provides safetensors, not official
Google Q6/Q8 GGUF files. A higher-precision GGUF therefore comes from an
explicit local llama.cpp conversion of that normal checkpoint or a reviewed
derivative such as `unsloth/gemma-4-12b-it-GGUF`.

At the reviewed Unsloth revision, `UD-Q6_K_XL` is 10.7 GB and
`UD-Q8_K_XL` is 13.6 GB, compared with 6.98 GB for the current Google QAT
Q4_0 main. Q8 should reduce quantization error and fits a 32 GB GPU in
isolation, but it is not simply a higher-bit serialization of this QAT target.
An improvement could reflect both the normal-model lineage and quantization.
The current clean corpus gives a concrete comparison case: QAT Q4 failed to
remove the Japanese `スペイン語にして` instruction in both MTP off and on.

Do not combine the current QAT Q4 main with a normal-model projector or
drafter. Google's QAT model card requires a QAT assistant of matching precision
for speculative decoding. Treat a Q6/Q8 trial as a separate pinned profile
containing its own main, matching `mmproj`, matching MTP drafter if enabled,
hashes, VRAM result, and corpus report. `GEMMA4_INTERPRETER_MODEL`,
`GEMMA4_INTERPRETER_MMPROJ`, and `GEMMA4_INTERPRETER_MTP` permit an explicit
manual trial, but such a result must not be consumed by the current QAT
`auto` manifest validator.

Sources:

- [Google QAT Q4 GGUF](https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf)
- [Google normal 12B instruction model](https://huggingface.co/google/gemma-4-12B-it)
- [Unsloth normal-model GGUF files](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/tree/main)

### Three different readiness levels

Do not treat these as one requirement:

1. **Runtime ready** requires `llama-server`, the main GGUF, and the matching
   `mmproj`. This is sufficient for `GEMMA4_MTP=off`.
2. **MTP artifact ready** additionally requires the verified assistant GGUF and
   llama-server's `draft-mtp` flags. This is sufficient for `GEMMA4_MTP=on`.
3. **MTP rebuild ready** additionally requires a source checkout,
   `convert_hf_to_gguf.py`, Gemma assistant architecture registration,
   `llama-quantize`, conversion requirements, and at least 4 GiB free for the
   assistant-only temporary files.

Check the existing checkout without modifying it:

    ./scripts/check-llama-gemma4.sh \
      --llama-dir /path/to/llama.cpp \
      --mtp-mode off

    ./scripts/check-llama-gemma4.sh \
      --llama-dir /path/to/llama.cpp \
      --mtp-mode on \
      --require-build-tools

The recorded known-good llama.cpp commit is
`c1304d7b28e14380dbb90252c92aa2798db60185` (observed build version 9671).
The checker accepts a capability-compatible binary but warns when commit or
dirty state differs. It never pulls, checks out, resets, or cleans that
repository.

The checker accepts newer capability-compatible builds, so an existing
checkout does not have to match that commit exactly. MTP remains off by default.
When explicitly enabled, draft 8 is the measured starting value for this
implementation; benchmark another GPU or model combination before changing it
or approving `auto`.

### Reuse or explicitly install llama.cpp

If a compatible checkout already exists, point `LLAMA_CPP_DIR` or
`--llama-dir` at it. If none exists, first inspect host dependencies:

    ./scripts/setup-llama-cpp-gemma4.sh --check-deps

Preview a new, separate checkout:

    ./scripts/setup-llama-cpp-gemma4.sh \
      --prefix /path/to/new/llama.cpp-gemma4 \
      --dry-run

The non-dry-run command clones only into a new explicit path, detaches at the
known-good commit, and builds with `GGML_CUDA=ON` and `GGML_CUDA_FA=ON`. It
refuses to touch an existing target. `--cuda-architectures 120a-real` is an
optional host-specific Blackwell setting, not a portable default. The script
does not use `sudo` or install OS packages.

The equivalent manual build is:

    git clone https://github.com/ggml-org/llama.cpp.git /path/to/new/llama.cpp-gemma4
    git -C /path/to/new/llama.cpp-gemma4 checkout --detach c1304d7b28e14380dbb90252c92aa2798db60185
    cmake -S /path/to/new/llama.cpp-gemma4 \
      -B /path/to/new/llama.cpp-gemma4/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DGGML_CUDA=ON \
      -DGGML_CUDA_FA=ON
    cmake --build /path/to/new/llama.cpp-gemma4/build --config Release --parallel

### Runtime setup

Preview the current files before any network access:

    ./scripts/setup-gemma4-interpreter.sh \
      --llama-dir /path/to/llama.cpp \
      --dry-run

If files are missing, the non-dry-run command downloads only the pinned main
GGUF and projector. It refuses to overwrite a file whose hash is not registered.
MTP is optional:

    ./scripts/setup-gemma4-interpreter.sh \
      --llama-dir /path/to/llama.cpp \
      --with-mtp

The normal Gemma server launch is offline and fails with a setup instruction
when an artifact is missing:

    GEMMA4_MTP=off ./scripts/run-gemma4-interpreter.sh --dry-run
    GEMMA4_MTP=on GEMMA4_INTERPRETER_DRAFT_TOKENS=8 \
      ./scripts/run-gemma4-interpreter.sh --dry-run

`off` is the default. When MTP is explicitly `on`, the draft limit defaults to
8 and remains overrideable from 1 through 32. `auto` turns MTP on only when
the configured approval manifest contains an explicitly approved result that
matches the current GPU name and memory, llama.cpp commit, official
main/projector/assistant hashes, and measured draft count. A copied
`recommended: true` from another machine is rejected.

Preview the complete off/1/2/4/8/16 benchmark without loading a model:

    ./scripts/benchmark-gemma4-mtp.sh \
      --cases /path/to/interpreter-cases.json \
      --draft-tokens 1,2,4,8,16 \
      --dry-run

The case JSON points to 16 kHz mono WAV files and declares the expected source
and target for each recording. A live run starts only one loopback
`llama-server` at a time, records first content, total wall time,
llama-server timings, draft acceptance, schema/direction validity, and GPU
memory, then stops the exact PID it created. It writes `recommended: false`
unless a reviewed passing draft is explicitly repeated with
`--approve-draft N`. By default it refuses to start while another GPU compute
process is present. `--allow-contended-gpu` is available only for diagnostic
measurement, and such a result cannot be approved or accepted by `auto`.

### Rebuild the assistant GGUF

The assistant checkpoint is a standalone
`Gemma4AssistantForCausalLM`/`Gemma4UnifiedAssistantForCausalLM` model.
llama.cpp's converter recognizes that architecture directly. Do **not** pass
the converter's `--mtp` option: in the recorded llama.cpp revision that option
is for other model families and rejects this Gemma input.

Preview:

    ./scripts/build-gemma4-gguf.sh \
      --component assistant \
      --llama-dir /path/to/llama.cpp \
      --source-dir /path/to/google-assistant-snapshot \
      --output-dir /path/to/gemma-runtime \
      --dry-run

An already verified MTP GGUF prints `reuse` and performs no conversion. An
explicit rebuild uses a dedicated `.venv-gemma4-convert`, installs the selected
llama.cpp revision's own conversion requirements, writes F16 and Q4_0 temporary
files on the destination filesystem, checks exit status, nonzero size, GGUF
magic, bytes, and SHA256, and only then publishes the Q4_0 file:

    ./scripts/build-gemma4-gguf.sh \
      --component assistant \
      --llama-dir /path/to/llama.cpp \
      --source-dir /path/to/google-assistant-snapshot \
      --output-dir /path/to/gemma-runtime \
      --rebuild

Source safetensors are never removed. Failed F16/Q4 temporary files and the log
are retained for diagnosis. Successful F16 output is removed unless
`--keep-f16` is supplied.

### Model update policy

Run:

    ./scripts/check-interpreter-model-updates.sh

This compares the pinned repositories to current Hugging Face heads without
downloading weights. A difference means “review,” not “install.” Review the
Google main GGUF, projector, and assistant as a matched set, then update the
manifest, hashes, compatibility tests, and benchmark deliberately. Do not
replace only one component with an Unsloth or newer official file.

Gemma 4 model files are published under
[Apache License 2.0](https://ai.google.dev/gemma/apache_2). Conversion or
quantization into GGUF does not remove its notice and redistribution
conditions. Keep Hugging Face credentials and download tokens out of scripts,
manifests, and Git.

<a id="japanese"></a>
## 日本語

通訳用Gemmaの正本はGoogle公式のGemma 4 12B QAT artifactです。Unsloth量子化は比較候補に
できますが、公式source revisionとmain/projector/assistantの対応を確認せずcore setupへ
混ぜません。最近の公式修正を取りこぼさず、組合せ不一致を防ぐためです。来歴は
[`config/models/gemma4-interpreter.json`](../../config/models/gemma4-interpreter.json)
に固定しています。

### 既に完成しているMTP GGUF

`mtp-gemma-4-12B-it-qat-Q4_0.gguf` は将来作る予定のfileではありません。Google公式
assistant safetensorsをGGUFへ変換し、Q4_0量子化した検証済みfileです。sizeは
322,915,136 bytes、SHA256は
`25f143b4c15b20cd04216e35e99bd7a56afc6f65e7a4e090a3e20091bb590cbb`
です。現在のsystem Pythonにtorchがないことは、この変換が失敗したという意味では
ありません。build scriptは完成fileのhashが一致すれば再利用します。

mainは `gemma-4-12b-it-qat-q4_0.gguf`、対応projectorは
`mmproj-gemma-4-12b-it-qat-q4_0.gguf` です。旧来の一般名
`mmproj-model-f16.gguf` を使わないでください。

### Q6/Q8を比較する場合

Google公式のready-to-run 12B QAT GGUFは現在Q4_0だけです。通常版
`google/gemma-4-12B-it`はsafetensorsで、Google自身のQ6/Q8 GGUFはありません。
高bit GGUFは通常版をllama.cppで明示変換するか、review済みの
`unsloth/gemma-4-12b-it-GGUF`などを使います。

確認時点のUnsloth通常版は`UD-Q6_K_XL`が10.7 GB、`UD-Q8_K_XL`が13.6 GBです。
現在のGoogle QAT Q4_0 mainは6.98 GBなので、Q8は量子化誤差を減らし32 GB GPU内にも
収まる見込みですが、同じQAT targetの単なる高bit版ではありません。改善時は通常版系列と
quantization両方の差を含みます。現在のclean corpusではQAT Q4がMTP off/on共通で
日本語の「スペイン語にして」をcontentから除けなかったため、比較する価値があります。

現在のQAT Q4 mainへ通常版projector/drafterを混ぜません。GoogleのQAT model cardは
speculative decoding時に同じQAT precisionのassistantを要求します。Q6/Q8はmain、
対応`mmproj`、MTPを使うなら対応drafter、hash、VRAM、corpus reportを持つ独立profileとして
扱います。`GEMMA4_INTERPRETER_MODEL`、`GEMMA4_INTERPRETER_MMPROJ`、
`GEMMA4_INTERPRETER_MTP`で手動比較はできますが、現在のQAT用`auto` validatorへその結果を
流用しません。

参照:

- [Google QAT Q4 GGUF](https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf)
- [Google通常版12B IT](https://huggingface.co/google/gemma-4-12B-it)
- [Unsloth通常版GGUF一覧](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/tree/main)

### runtimeとbuildを分けて確認する

    ./scripts/check-llama-gemma4.sh \
      --llama-dir /path/to/llama.cpp \
      --mtp-mode off

    ./scripts/check-llama-gemma4.sh \
      --llama-dir /path/to/llama.cpp \
      --mtp-mode on \
      --require-build-tools

`off` の日常runtimeには `llama-server`、main、mmprojだけが必要です。`on` にはさらに
assistant GGUFと `draft-mtp` flagが必要です。将来再変換する場合だけconverter、
Gemma assistant architecture登録、`llama-quantize`、専用Python環境、4 GiB以上の空きが
必要です。互換runtimeがあることと、MTPを再buildできることを混同しません。

既知のllama.cpp commitは
`c1304d7b28e14380dbb90252c92aa2798db60185`、観測build versionは9671です。既存checkoutは
dirtyであっても勝手にpull、checkout、reset、cleanしません。互換checkoutがなければ、
新しい明示pathだけへ導入します。

checkerは必要機能を持つ新しいbuildも受理するため、既存checkoutがこのcommitと完全一致
する必要はありません。MTPは既定offです。明示的にonにする場合、draft 8をこの実装の
実測済み開始値としますが、別GPUや別model構成で変更または`auto`承認する前には再測定して
ください。

    ./scripts/setup-llama-cpp-gemma4.sh --check-deps
    ./scripts/setup-llama-cpp-gemma4.sh \
      --prefix /path/to/new/llama.cpp-gemma4 \
      --dry-run

### Gemma artifactの導入

    ./scripts/setup-gemma4-interpreter.sh \
      --llama-dir /path/to/llama.cpp \
      --dry-run

実行版は不足しているpinned main/mmprojだけを取得します。登録外hashの既存fileは上書き
しません。MTP source/buildも必要な場合だけ `--with-mtp` を付けます。通常起動はofflineで、
不足時に自動downloadしません。

    GEMMA4_MTP=off ./scripts/run-gemma4-interpreter.sh --dry-run
    GEMMA4_MTP=on GEMMA4_INTERPRETER_DRAFT_TOKENS=8 \
      ./scripts/run-gemma4-interpreter.sh --dry-run

MTP既定値はoffです。MTPを明示的にonにした場合のdraft既定値は8で、1から32まで
上書きできます。autoは同じartifact/hardwareのbenchmark manifestに
明示承認済みの `recommended: true` があり、GPU名/容量、llama.cpp commit、
main/mmproj/assistant hash、測定したdraft数まで現在環境と一致する場合だけonになります。
別machineからコピーした真偽値だけでは有効になりません。

modelをloadしないpreview:

    ./scripts/benchmark-gemma4-mtp.sh \
      --cases /path/to/interpreter-cases.json \
      --draft-tokens 1,2,4,8,16 \
      --dry-run

live実行はloopbackの `llama-server` を一つずつ起動し、first content、total、
llama-server timing、draft acceptance、schema/方向、GPU memoryを記録して、自分が
起動した正確なPIDだけを停止します。合格候補を確認後 `--approve-draft N` を明示しない
限り `recommended` はfalseです。既存のGPU compute processがある場合は既定で開始を拒否
します。診断用の `--allow-contended-gpu` は承認と併用できず、その結果を `auto` も拒否
します。

### assistantを再変換する場合

assistantはstandalone Gemma assistant architectureなのでconverterへ `--mtp` を付けません。
記録済みllama.cppでは、そのoptionは別model family向けです。

    ./scripts/build-gemma4-gguf.sh \
      --component assistant \
      --llama-dir /path/to/llama.cpp \
      --source-dir /path/to/google-assistant-snapshot \
      --output-dir /path/to/gemma-runtime \
      --dry-run

完成GGUFのhashが一致すれば `reuse` と表示して何もしません。明示的に再作成する時だけ
`--rebuild` を付けます。専用 `.venv-gemma4-convert`、一時F16/Q4_0、logを使い、GGUF
header、size、hash検証後に最終fileを公開します。source safetensorsは削除しません。

更新確認はread-onlyです。

    ./scripts/check-interpreter-model-updates.sh

差があっても自動更新しません。Googleのmain、projector、assistantを一組としてreviewし、
manifest、hash、互換test、benchmarkを意図的に更新してください。

Gemma 4 model fileは
[Apache License 2.0](https://ai.google.dev/gemma/apache_2)で公開されています。GGUFへの
変換や量子化を行っても、元modelのnoticeと再配布条件は消えません。Hugging Faceの認証情報や
download tokenはscript、manifest、Gitへ保存しないでください。
