# セットアップガイド — clone しただけでは動かない理由と、動かすための手順

このリポジトリは、Muse の「スペース」（TypeScript スペース、`space.json` の slug: `riarutaimucheng-rihuan-eque-ren-apuri`、アプリ名：リアルタイム乗り換え確認アプリ）の**ソースコードのミラー**です。
スペースは Muse のランタイム上で動く前提で作られているため、**このリポジトリを clone しただけでは、そのまま他の環境では動きません。**
このガイドでは「何が含まれていないか」「どこを差し替えれば動くか」をまとめます。

ホテル予約アプリ（`hotel-booking-app`）のガイドと共通する部分が多いですが、このアプリ固有の違い（特に §6：不足する画像がビルドを止めないこと）も明記しています。

---

## 1. 結論：不足しているもの一覧

| # | 不足しているもの | 影響 | 対処 |
|---|---|---|---|
| 1 | `@hatch/space-sdk` 本体 | `bun install` が失敗する（最重要） | §4-A / §4-B を参照 |
| 2 | DB ファイル `app.db` | 経路・徒歩学習・運行情報キャッシュが保存できない | §5 の手順で空の DB を再作成 |
| 3 | ランタイム提供の `ctx.*` サービス | 経路の保存・遅延情報の取得が動かない | §7 の対応表で自前実装に差し替え |
| 4 | ビルド成果物 `client/dist/`、`server/dist/` | 配信する HTML / JS がない | ビルドで再生成（ただし #1 が前提） |
| 5 | `node_modules/` | 依存モジュールがない | `bun install` で再生成（ただし #1 が前提） |

`.gitignore` で除外されているもの：`node_modules/`、`client/dist/`、`client/dist-cvm/`、`server/dist/`、`app.db*`、`*.tsbuildinfo`、`*.webp`

**注意（ホテルアプリとの違い）**：このアプリにはヒーロー画像のような、コードから import される画像アセットがありません（§6）。画像不足でビルドが止まることはありません。

---

## 2. なぜ `@hatch/space-sdk` が無いと詰むのか

`package.json` の依存はこうなっています。

```json
"@hatch/space-sdk": "file:/opt/hatch/skills/spaces/ts-runtime/dist/space-sdk.tgz"
```

つまり SDK は npm レジストリではなく、**Muse 環境内にあるローカルファイル**を指しています。
Muse の外ではこのパスが存在しないため、`bun install` が失敗し、以下すべてが止まります。

SDK を使っている場所：

| ファイル | SDK の利用 |
|---|---|
| `server/src/actions.ts` | `defineAction`、`z`、`ActionsModule` / `Ctx` 型 |
| `client/src/api.ts` | `createActionClient`（`./actions` へ POST する型付き RPC クライアント） |
| `client/src/main.tsx` | `spaceQueryClient` |
| `client/src/App.tsx` | `SafeAreaTopScrim` |
| `client/build.mjs` | `buildClient`（`@hatch/space-sdk/build`、バンドル処理一式） |

---

## 3. リポジトリ構成

```
.
├── space.json            # スペース定義（runtime: typescript / platformVersion: 28 / entry: client/dist/index.html）
├── package.json          # Bun プロジェクト定義（packageManager: bun@1.3.10）
├── bun.lock / bunfig.toml
├── client/
│   ├── index.html        # favicon は data: で無効化済み（外部画像なし）
│   ├── build.mjs         # SDK の buildClient を呼ぶだけの薄いラッパー
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx      # エントリ（data-generated-space-root 要素にマウント）
│       ├── App.tsx       # UI 本体（発車標ボード／経路／学習の3ビュー、GPS補正）
│       ├── api.ts        # サーバーアクションへの型付きクライアント
│       ├── theme.css
│       ├── lib/
│       │   └── predict.ts  # 乗れる電車の予測計算（純粋な TypeScript、移植しやすい）
│       └── components/
│           ├── RouteEditor.tsx  # 経路エディタ
│           └── icons.tsx        # アイコン（SVG、同梱済み）
├── server/
│   ├── tsconfig.json
│   └── src/
│       ├── actions.ts    # サーバーアクション本体（§7）
│       └── schema.ts     # Drizzle スキーマ（§5）
└── drizzle/              # SQLite マイグレーション
    ├── 0001_initial.sql
    ├── 0002_transit_tables_replace_entries.sql
    └── meta/_journal.json
```

前提バージョン（`package.json` より）：Bun 1.3.10、React 19.2.5、drizzle-orm 0.45.2、TypeScript 5.6.3、@tanstack/react-query 5.100.10、zod 4.4.3、recharts 2.15.3。

アプリの中心である予測計算（現在位置から徒歩＋乗り換え＋安全余裕を差し引いて「今から乗れる電車」を出す処理）は `client/src/lib/predict.ts` にあり、ランタイム依存のない純粋な計算です。時刻は日本時間（JST）前提で処理しています。

---

## 4. 動かし方

### 4-A. Muse のスペースとして復元する（確実な方法）

SDK も DB も Muse のランタイムが用意するため、この方法が一番素直です。

1. Muse 上で TypeScript スペースを用意し、このリポジトリのソースをそのスペースのソース一式として配置する（`space.json` の slug / runtime を維持）。
2. Muse のビルド／配置フローでビルドする（`bun run build` を手で回して公開する形式ではありません。スペースのビルドは Muse 側の仕組みで行います）。
3. DB はランタイムが空の `app.db` を作り、`drizzle/` のマイグレーションが適用されれば、経路登録などは空の状態から使い始められます（過去の経路・学習データは移行されません、§5）。

### 4-B. Muse の外（独自環境）へ移植する

移植作業として、最低限次の差し替えが必要です。目安として「UI と予測計算（React＋`predict.ts`）はほぼそのまま使えるが、サーバーとビルドは SDK 前提を外す作業になる」と考えてください。

1. **依存の解決**
   - `@hatch/space-sdk` の `file:` 依存を外す。`client/build.mjs` は SDK の `buildClient` 前提なので、Vite 等の通常のバンドラに置き換える。
   - `client/src/main.tsx` の `spaceQueryClient` は通常の `QueryClient`（@tanstack/react-query）に、`SafeAreaTopScrim` は自前のコンポーネントか削除に置き換える。
2. **アクション層の実装**
   - `client/src/api.ts` の `createActionClient` は「`./actions` へ `{action, args}` を POST する」クライアントです。自前の HTTP サーバー（Hono / Express 等）で同じ形のエンドポイントを用意するか、`api.ts` 自体を通常の fetch クライアントに書き換える。
   - `server/src/actions.ts` の `defineAction` は zod スキーマ付きの関数定義です。各アクションを通常の関数／ルートとして切り出す。
3. **DB の用意**：§5 の通り SQLite ファイルを作り、Drizzle から接続する（`ctx.db` の差し替え、§7）。
4. **`ctx.*` の差し替え**：§7 の対応表の通り、運行情報の Web 検索と推論（LLM）を自前の API に置き換える。
5. **動作確認**：経路の登録／選択、徒歩実績の記録（学習への反映）、運行情報の更新（遅延の反映）、GPS 補正（ブラウザの位置情報許可が必要）まで一通り確認する。

アクション一覧（`server/src/actions.ts`）：`getState`、`saveRoute`、`deleteRoute`、`setActiveRoute`、`recordWalk`、`deleteWalkLog`、`setManualDelay`、`refreshLineStatus` の 8 つ。

---

## 5. DB（`app.db`）について

- 実データの入った `app.db` は**意図的にリポジトリへ上げていません**（利用者が登録した経路・徒歩実績というユーザーデータのため、`.gitignore` 対象）。
- スキーマ定義は `server/src/schema.ts`、マイグレーションは `drizzle/` にあります。テーブルは次の 5 つです。
  - `routes`（登録経路：名前、安全余裕の分数など）
  - `segments`（経路の区間列：徒歩／乗車、駅・路線、発車時刻リスト、緯度経度など）
  - `walk_logs`（徒歩実績：予定と実績。学習に使う）
  - `line_status`（路線ごとの運行情報キャッシュ：状態、遅延分数、手動上書き、取得元 URL など）
  - `app_settings`（アプリ設定：選択中の経路など）
- 再作成手順：空の SQLite ファイルを用意し、**`0001_initial.sql` → `0002_transit_tables_replace_entries.sql` の順に両方**を適用してください。
  - 注意：`0001` は旧形式の `entries` テーブルを作るだけの初期マイグレーションで、`0002` がそれを削除して上記 5 テーブルを作ります。`0002` だけを適用しても動きますが、履歴（`drizzle/meta/_journal.json`）と揃えるなら両方を順に適用するのが正規手順です。
- DB の中身は空からで問題ありません（本番スペースも空の状態で出荷されています）。ダイヤ（発車時刻）も経路登録時にユーザーが入力する設計で、外部ダイヤデータは同梱されていません。

---

## 6. 画像について（ブロッカーなし）

- このアプリは、コードから import される画像アセットを持ちません。アイコンは `client/src/components/icons.tsx` の SVG、favicon は `client/index.html` で `data:,` として無効化されています。
- スペースのアイコン画像 `icon.webp`（スペース直下）はバイナリのためリポジトリに含まれていませんが（`*.webp` は `.gitignore` 対象）、**アプリの実行・ビルドには不要**です。ホテルアプリのヒーロー画像のような「無いとビルドが失敗する」問題はこのアプリにはありません。

---

## 7. ランタイム依存（`ctx.*`）の対応表

`server/src/actions.ts` は、Muse のスペースランタイムが注入する `ctx` に依存しています。リポジトリには `ctx` の実装は含まれません。

| 利用箇所 | 役割 | 独自環境での代替 |
|---|---|---|
| `ctx.db<typeof schema>()` | Drizzle 経由の SQLite アクセス | `drizzle-orm` + `bun:sqlite` 等で自前の DB 接続を用意 |
| `ctx.tool.web_search(q)` | 運行情報の検索（`refreshLineStatus`：「<路線名> 運行情報 遅延 現在」で検索し、JR東日本など公式ソースを優先） | 検索 API（Brave / Tavily / SerpAPI 等）。要 API キー |
| `ctx.inference.complete(...)` | 検索結果から運行状況（平常／遅延／運休／不明、最大遅延分数、要約）を zod スキーマで構造化判定 | LLM API（構造化出力）。要 API キー |
| `ctx.invalidateQueries()` | クライアント側キャッシュの無効化 | React Query の `queryClient.invalidateQueries` 相当を自前で |

補足：

- 遅延情報は上記の検索＋推論で取得し、`line_status` テーブルにキャッシュされます。手動で遅延を上書きする機能（`setManualDelay`）は DB だけで完結するため、`ctx.tool` / `ctx.inference` を差し替えなくても手動運用は可能です。
- GPS 補正はクライアント側でブラウザ標準の `navigator.geolocation` を使うため、外部 API やキーは不要です（HTTPS 等、位置情報が使える配信環境は必要）。
- API キーや秘密情報はコード内に含まれていません（`.env` 等もありません）。移植先で検索 API / LLM のキーを用意する場合は、環境変数で渡し、リポジトリにコミットしないでください。

---

## 8. コマンド

`package.json` の scripts（いずれも SDK が揃っている前提）：

```bash
bun install        # 依存インストール（§2 の理由で Muse 外では失敗する）
bun run typecheck  # client / server の型チェック
bun run build      # build:server（actions を bun build）と build:client の一括
```

---

## 9. トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `bun install` で `@hatch/space-sdk` が見つからない | 想定内です（§2）。4-A で復元するか、4-B の差し替えを行ってください |
| 経路／学習データが保存されない | DB が未作成です。§5 の通りマイグレーションを適用してください |
| 運行情報の更新が失敗する | `ctx.tool.web_search` / `ctx.inference` 相当が未実装か、検索 API / LLM のキーが未設定の可能性があります（§7）。手動遅延（`setManualDelay`）での運用は可能です |
| GPS 補正が効かない | ブラウザの位置情報許可と、地点（区間）への緯度経度登録を確認してください。未登録の地点では補正されません |
| 乗れる電車が表示されない | 選択中の経路があるか、区間に発車時刻が登録されているかを確認してください。予測計算自体は `client/src/lib/predict.ts` で完結しています |

---

## 10. このリポジトリの同期について

- このリポジトリは、Muse 上のスペースの変更に追随して随時コミット＆プッシュされるミラーです（テキストファイルのみ。バイナリ・DB・ビルド成果物は含まれません）。
- そのため、独自環境向けの移植作業は**ブランチを切って**行うのがおすすめです。`main` へ直接手を入れると、次の同期プッシュと競合する場合があります。
- 仕様・データ取得方針の詳細は `DATA-PLAN.md` を参照してください。
- `README.md` とこの `GUIDE.md` はリポジトリ側だけに置かれたドキュメントで、スペースのソース同期対象ではありません（同期時に消したり上書きしたりはしません）。
