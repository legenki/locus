# locus: форк omp для Zed на macOS

Это форк [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`), который подключается к Zed как внешний агент через [Agent Client Protocol](https://agentclientprotocol.com).

Всё, что нужно для Zed, уже есть в upstream: команда `omp acp` запускает агента по ACP. Zed передаёт ему файлы, терминал и запросы разрешений. В форке добавлены только скрипт установки и эта инструкция. Код агента не менялся.

## Быстрый старт

```sh
git clone https://github.com/legenki/locus.git ~/src/locus
cd ~/src/locus
scripts/zed/setup-macos.sh
```

Скрипт:

1. проверяет Xcode CLT, Bun ≥ 1.4.4 и rustup (нативному аддону нужен nightly из `rust-toolchain.toml`, формулы `brew install rust` не хватит);
2. выполняет `bun install` и `bun run build:native`;
3. создаёт `~/.local/bin/omp-fork`, симлинк на dev-лаунчер `packages/coding-agent/scripts/omp`. Если параллельно стоит релизный `omp` из Homebrew, они не конфликтуют;
4. печатает блок для настроек Zed и копирует его в буфер обмена.

Потом:

1. В Zed открой `cmd-,` (Open Settings), вставь блок внутрь корневого объекта и сохрани.
2. Открой Agent Panel (`cmd-?`), нажми `+` и выбери **omp (fork)**.
3. Один раз залогинься у провайдера моделей в терминале: `omp-fork`, затем `/login`. Креды лежат в `~/.omp` и доступны в Zed.

Если ставить скрипт не хочется, то вот как выглядит блок настроек:

```jsonc
{
  "agent_servers": {
    "omp (fork)": {
      "type": "custom",
      "command": "/Users/<you>/.local/bin/omp-fork",
      "args": ["acp"],
      "env": {
        // Zed — GUI-приложение и не видит PATH из ~/.zshrc.
        // Лаунчер вызывает `bun`, поэтому путь к нему нужно указать явно.
        "PATH": "/Users/<you>/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
      }
    }
  }
}
```

## Цикл разработки

- **Правки в TypeScript** (`packages/*/src`): ничего пересобирать не надо, лаунчер запускает исходники через Bun. Достаточно открыть новый тред в Agent Panel, и Zed перезапустит агента.
- **Правки в Rust** (`crates/`, `packages/natives`): `scripts/zed/setup-macos.sh --native-only`.
- **Логи ACP** в Zed: командная палитра → `dev: open acp logs`. Там видно JSON-RPC между Zed и omp.
- **Другое имя агента:** `scripts/zed/setup-macos.sh --name "omp dev"`.

## Синхронизация с upstream

```sh
git remote add upstream https://github.com/can1357/oh-my-pi.git   # один раз
git fetch upstream
git merge upstream/main        # или rebase, если своих коммитов немного
```

Свои изменения лучше держать отдельными коммитами поверх upstream, тогда мерджи останутся простыми.

## Что работает через ACP

| Инструмент omp | Как он идёт через Zed               |
| -------------- | ----------------------------------- |
| `bash`         | `terminal/create`, `terminal/output` |
| `read`         | `fs/read_text_file`, читает несохранённый буфер |
| `write`        | `fs/write_text_file`, пишет через save-path редактора |
| `edit`, `bash` | `session/request_permission`, запрос разрешения в Zed |

MCP-серверы в ACP-сессии задаются из Zed (`context_servers`), а не из конфига omp.
