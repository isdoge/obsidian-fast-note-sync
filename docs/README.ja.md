[简体中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.zh-CN.md) / [English](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/README.md) / [日本語](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ja.md) / [한국어](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ko.md) / [繁體中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.zh-TW.md)

> [!IMPORTANT]
> **本リポジトリは独自にメンテナンスされている修正版です。** 上流の [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync) は 2026 年 8 月以降更新されていません。本リポジトリは [isdoge](https://github.com/isdoge) が上流の v2.4.0 からフォークし、未処理だった PR のマージと既知の不具合の修正を行ったうえで独自に開発を続けており、バージョン番号も上流とは連動しません。**Obsidian のコミュニティプラグインストアからはインストール・更新しないでください。** ストアにあるのは上流版です。詳しくは下記の「本リポジトリについて」をご覧ください。

不具合の報告やご要望は、本リポジトリに新しい [issue](https://github.com/isdoge/obsidian-fast-note-sync/issues/new) を作成してください。




<h1 align="center">Fast Note Sync For Obsidian</h1>

<p align="center">
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/release/isdoge/obsidian-fast-note-sync?style=flat-square" alt="release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/v/tag/isdoge/obsidian-fast-note-sync?label=release-alpha&style=flat-square" alt="alpha-release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/blob/master/LICENSE"><img src="https://img.shields.io/github/license/isdoge/obsidian-fast-note-sync?style=flat-square" alt="license"></a>
    <img src="https://img.shields.io/badge/Language-TypeScript-00ADD8?style=flat-square" alt="TypeScript">
</p>



<p align="center">
  <strong>高速なマルチデバイス同期、自動バックアップ、追跡可能なバージョン履歴、および共有・共同編集が可能な Obsidian 用ノート同期プラグイン</strong>
  <br>
  <em>PC、モバイル、ウェブなど、複数のデバイス間でノートをいつでもどこでもリアルタイムに同期します。ワンクリックで共有リンクを生成して友人と共有でき、編集履歴の追跡やゴミ箱の中身の復元も簡単に行えます。さらに、バックアップ、ミラーリング、Git同期にも対応しています。Fast Note Sync Service が提供する REST/MCP サービスを利用することで、自分だけの個人知識ベースを迅速に構築できます。</em>
</p>

<p align="center">
  独立したサーバーが必要です：<a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
</p>

<div align="center">
    <img src="/docs/images/demo.gif" alt="fast-note-sync-service-preview" width="800" />
</div>


## 📌 本リポジトリについて

本リポジトリは [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync) の独自メンテナンス版です。メンテナーは [isdoge](https://github.com/isdoge) です。本プロジェクトを作成された原作者の HaierKeys 氏に感謝いたします。

- **由来**：上流の v2.4.0 から分岐し、当時未処理だった 18 件の PR をマージしたうえで既知の不具合を修正しました。詳細は[更新履歴（中国語）](/docs/CHANGELOG.zh-CN.md)をご覧ください。
- **バージョン番号**：v2.5.0 以降は独自にインクリメントされ、上流には追従しません。
- **プラグイン ID はそのまま**：引き続き `fast-note-sync` です。本リポジトリのリリースファイルを `.obsidian/plugins/fast-note-sync` に上書きするだけで、既存の設定や同期履歴がそのまま引き継がれ、再設定は不要です。
- **インストールと更新**：本リポジトリの [GitHub Releases](https://github.com/isdoge/obsidian-fast-note-sync/releases) のみで配布しており、Obsidian のコミュニティプラグインストアには公開していません。プラグイン内のワンクリック更新は本リポジトリの Releases からダウンロードします。新バージョンの通知は接続先のサーバーから配信され、本リポジトリのサーバーと組み合わせた場合に本リポジトリを参照します。Obsidian 標準の「アップデートを確認」はストア上の上流版を確認するため、本プラグインの更新には使わないでください。
- **対応サーバー**：同じく独自メンテナンスされている [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service)（v3.7.0 以上）と組み合わせてご利用ください。一部の修正はプラグインとサーバーの両方をアップデートすることで有効になります。
- **変更しない点**：原作者の著作権表示およびスポンサー情報。
- **フィードバック**：不具合の報告やご要望は上流リポジトリではなく、本リポジトリの [Issues](https://github.com/isdoge/obsidian-fast-note-sync/issues) にお寄せください。

### 削除された機能・項目

独自メンテナンス版では以下の項目を削除しています。**必要な項目がある場合は、利用シーンを添えて [issue を作成](https://github.com/isdoge/obsidian-fast-note-sync/issues/new) してお知らせください。復元を検討します。**

| 削除された項目 | 説明 | 代替手段 |
| --- | --- | --- |
| Obsidian コミュニティプラグインストア経由のインストール | 本リポジトリはストアに公開しません。ストアにあるのは上流版（v2.4.0 で停止）です | 本リポジトリの Releases からダウンロードして上書きインストールし、以降はプラグイン内の更新機能を使用 |
| Tencent `cnb.cool` ミラーリポジトリとダウンロード元 | cnb への同期を廃止しました。設定の「プラグイン更新元」には GitHub のみが残り、旧設定の cnb 値は自動的に GitHub として扱われます | GitHub Releases |

### 上流版からのアップグレード

- 本リポジトリの Releases から `main.js`、`manifest.json`、`styles.css`（または zip パッケージ）をダウンロードし、`.obsidian/plugins/fast-note-sync` 内の同名ファイルに上書きしたあと、Obsidian を再起動するかプラグインを再有効化してください。設定の変更は不要です。
- サーバーもあわせて [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service) v3.7.0 以上にアップグレードすることをおすすめします。
- **挙動の変更点**：
  - 他のデバイスで削除されたファイルは、Obsidian で設定した削除ファイルの処理方法（システムのごみ箱 / Obsidian のごみ箱 `.trash` / 完全に削除）に従って処理されるようになりました。完全削除に設定している場合、リモートからの削除も完全削除になります。
  - 読み取り専用デバイスは、ローカルディレクトリをサーバーへ報告しなくなりました。
  - 「ハッシュ計算数の制限」に `0` を入力すると無制限になります。
  - アップグレード前にすでに 1970 年と表示されているファイルの更新日時は自動では修正されません（表示のみの影響で、次回ファイル編集時に正常に戻ります）。修正しようとして「ローカルファイルを削除してから再取得する」ことはお控えください。Obsidian 上で削除するとサーバーや他のデバイスにも削除が同期されます。


## ✨ プラグイン機能

- 🚀 **極限までシンプルな設定**:
    - 面倒な設定は不要です。リモートサービスの構成を貼り付けるだけで、すぐに使い始めることができます。
    - また、デスクトップ版ではワンクリックインポートを使用して自動的に認証を完了することもできます。
    - モバイル版で設定の貼り付けに失敗した際は原因を表示し、JSON の手動貼り付けにも対応しています。
- 📗 **ノートのリアルタイム同期**:
    - Vault（保管庫）内のすべてのノートの作成、更新、削除操作を自動的に監視して同期します。
    - 他のデバイスで削除されたファイルは Obsidian で設定した削除ファイルの処理方法（システムのごみ箱 / Obsidian のごみ箱 `.trash` / 完全に削除）に従って処理され、直接完全削除されることはなくなりました。
- 🖼️ **添付ファイルの完全サポート**:
    - 画像、動画、音声などのあらゆる非設定ファイルをリアルタイムで同期します。
    > ⚠️ **注意**: v1.0以上、サーバー v0.9以上が必要です。添付ファイルのサイズを適切に管理してください。ファイルが大きいと同期の遅延が発生する可能性があります。
- ⚙️ **構成の同期**:
    - 構成同期機能を提供し、複数のデバイス間での構成同期をサポートします。複数のデバイスに手動で構成ファイルをコピーする手間から解放されます。
    - プラグインのサブディレクトリ内のテキストリソース（辞書ファイルなど）の同期に対応しました。
    > ⚠️ **注意**: v1.4以上、サーバー v1.0以上が必要です。現在はテスト段階ですので、注意して使用してください。
- 🛂 **同期の除外とホワイトリスト**:
    - 同期の除外とホワイトリスト機能を提供し、独自の同期戦略を指定できます。
- 🔄 **マルチデバイス同期**:
    - Mac、Windows、Android、iOS などのプラットフォームをサポートします。
    - 同期状態はファイルミラーとして保存され、モバイルのローカルストレージがシステムによって消去された場合でもミラーから復元できるため、全量同期に戻ることはありません。
    - 切断または再起動前に送信されなかった削除・名前変更は再接続後に再送されます。再送前にサーバーの内容を確認し、一致しない場合は中止するため、他のデバイスにある新しい内容を誤って削除しません。
- 📝 **ノートの履歴**:
    - ノートの履歴機能を提供し、ノートのすべての履歴変更の詳細を確認できます。
    - ノートを過去のバージョンに復元できます。
- 🛡️ **オフラインノート編集の自動マージ**:
    - オフラインデバイスでのノート変更は、サーバーに再接続したときに自動的にマージされ、最新の更新のみを保持することによるノート内容の消失を回避します。
- 🚫 **オフライン削除の同期と補完**:
    - オフライン中のノート、添付ファイル、構成の削除操作は、次回の接続時に自動的にサーバーに同期されるか、サーバーから自動的に補完されます。
- 🔍 **バージョン検出**:
    - バージョン検出機能を提供し、プラグイン側とサーバー側の最新バージョン情報を素早く取得して、迅速なアップグレードを可能にします。
    - ワンクリック更新は本リポジトリの GitHub Releases からダウンロードします。
- ☁️ **添付ファイルのクラウドプレビュー**:
    - 添付ファイルのオンラインプレビュー機能を提供します。添付ファイルをローカルデバイスに同期する必要がないため、ローカルストレージ容量を節約できます。
    > プラグインの除外設定と組み合わせることで、特定の添付ファイルに対してサーバーを経由せずにサードパーティのリポジトリ（WebDAVなど）を直接使用することができます。
- 🗒️ **同期ログ**:
    - 同期ログ機能を提供し、各同期の詳細情報を確認できます。
- **クラウドストレージバックアップ**: クラウドストレージバックアップ機能を提供し、ノートデータが失われないように保護します。

## 🗺️ ロードマップ (Roadmap)

ロードマップは原作者の計画を引き継いでいます。独自メンテナンス版ではこのリストに沿って項目ごとに進め、完了したものからチェックを入れていきます。
- [ ] **エンドツーエンド暗号化**: エンドツーエンド暗号化機能を提供し、ノートデータがどこに保存されていても安全であることを保証します。
- [ ] **AIノート**: AI+ノートに関連する革新的な活用方法を模索しています。皆様からの貴重な提案をお待ちしております。

> **改善の提案や新しいアイデアがある場合は、issue を提出して共有してください。適切な提案を慎重に評価し、採用させていただきます。**

## 💖 スポンサーとサポート

- 本プロジェクトは HaierKeys 氏によって作成されました。お役に立ちましたら、以下の方法から原作者をご支援いただけます（支援金は原作者に帰属し、本リポジトリのメンテナンスとは関係ありません）：

  | Ko-fi *中国以外*                                                                                 |    | WeChat *中国*                                  |
  |--------------------------------------------------------------------------------------------------|----|------------------------------------------------|
  | [<img src="/docs/images/kofi.png" alt="BuyMeACoffee" height="150">](https://ko-fi.com/haierkeys) | or | <img src="/docs/images/wxds.png" height="150"> |

- 支援者リスト：
  - <a href="https://github.com/isdoge/fast-note-sync-service/blob/master/docs/Support.ja.md">Support.ja.md</a>


## 🚀 クイックスタート

**ステップ 1：プラグインの取得**

* **手動インストール：** [GitHub リリースページ](https://github.com/isdoge/obsidian-fast-note-sync/releases) から `main.js`、`styles.css`、`manifest.json` をダウンロードし、`.obsidian/plugins/fast-note-sync` フォルダに配置して、Obsidian のコミュニティプラグイン一覧から有効にしてください。
* **上流版をご利用中の場合：** 上記の 3 つのファイルで同名ファイルを上書きするだけで、既存の設定はそのまま引き継がれます。
* 本プラグインは Obsidian コミュニティプラグインストアには公開されていません。ストアからインストールしないでください。

**ステップ 2：同期の承認**

1. 構築した **[Fast Note Sync Service](https://github.com/isdoge/fast-note-sync-service)** の Web インターフェースにアクセスします。
2. 左側のナビゲーションバーで **「ノート保管庫」** を選択します。
3. **「Obsidian を一クリックで承認」** をクリックすると、システムが自動的に Obsidian を呼び出し、承認情報の転送を自动的に完了します。もちろん、手動で承認情報をプラグインにコピーすることも可能です。

## 📦 サーバー側のデプロイ

バックエンドサービスの設定については、以下を参照してください：
- <a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
