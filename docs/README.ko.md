[简体中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.zh-CN.md) / [English](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/README.md) / [日本語](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ja.md) / [한국어](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.ko.md) / [繁體中文](https://github.com/isdoge/obsidian-fast-note-sync/blob/master/docs/README.zh-TW.md)

> [!IMPORTANT]
> **이 저장소는 독립적으로 유지보수되는 수정판입니다.** 업스트림 [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync)는 2026년 8월 이후 업데이트가 중단되었습니다. 이 저장소는 [isdoge](https://github.com/isdoge)가 업스트림 v2.4.0에서 포크하여 밀려 있던 PR을 병합하고 알려진 문제를 수정한 뒤 독립적으로 발전시켜 나가고 있으며, 버전 번호도 더 이상 업스트림을 따르지 않습니다. **Obsidian 커뮤니티 플러그인 스토어를 통해 설치하거나 업데이트하지 마세요.** 스토어에 등록된 것은 업스트림 버전입니다. 자세한 내용은 아래 「이 저장소에 대하여」를 참고해 주세요.

문제나 요청 사항이 있으면 이 저장소에 새 [issue](https://github.com/isdoge/obsidian-fast-note-sync/issues/new)를 등록해 주세요.




<h1 align="center">Fast Note Sync For Obsidian</h1>

<p align="center">
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/release/isdoge/obsidian-fast-note-sync?style=flat-square" alt="release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/releases"><img src="https://img.shields.io/github/v/tag/isdoge/obsidian-fast-note-sync?label=release-alpha&style=flat-square" alt="alpha-release"></a>
    <a href="https://github.com/isdoge/obsidian-fast-note-sync/blob/master/LICENSE"><img src="https://img.shields.io/github/license/isdoge/obsidian-fast-note-sync?style=flat-square" alt="license"></a>
    <img src="https://img.shields.io/badge/Language-TypeScript-00ADD8?style=flat-square" alt="TypeScript">
</p>



<p align="center">
  <strong>빠른 다중 기기 동기화, 자동 백업, 추적 가능한 버전 기록 및 공유 협업이 가능한 Obsidian용 노트 동기화 플러그인</strong>
  <br>
  <em>언제 어디서나 PC, 모바일, 웹 등 다양한 기기 간에 노트를 실시간으로 동기화합니다. 클릭 한 번으로 공유 링크를 생성하여 친구와 공유할 수 있으며, 편집 내역을 쉽게 추적하거나 휴지통의 내용을 복구할 수 있습니다. 또한 백업, 미러링 및 Git 동기화도 지원합니다. Fast Note Sync Service가 제공하는 REST/MCP 서비스를 활용하여 자신만의 개인 지식 베이스를 신속하게 구축할 수 있습니다.</em>
</p>

<p align="center">
  독립적인 서버가 필요합니다: <a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
</p>

<div align="center">
    <img src="/docs/images/demo.gif" alt="fast-note-sync-service-preview" width="800" />
</div>


## 📌 이 저장소에 대하여

이 저장소는 [haierkeys/obsidian-fast-note-sync](https://github.com/haierkeys/obsidian-fast-note-sync)의 독립 유지보수 버전이며, 메인테이너는 [isdoge](https://github.com/isdoge)입니다. 이 프로젝트를 만든 원저작자 HaierKeys님께 감사드립니다.

- **출처**: 업스트림 v2.4.0에서 분기하여 당시 미처리 상태였던 18개의 PR을 병합하고 여러 알려진 문제를 수정했습니다. 전체 목록은 [변경 내역(중국어)](/docs/CHANGELOG.zh-CN.md)에서 확인할 수 있습니다.
- **버전 번호**: v2.5.0부터 독립적으로 증가하며 더 이상 업스트림을 따르지 않습니다.
- **플러그인 ID 유지**: 계속 `fast-note-sync`를 사용합니다. 이 저장소에서 배포하는 파일을 `.obsidian/plugins/fast-note-sync` 폴더에 덮어쓰기만 하면 기존 설정과 동기화 기록이 그대로 유지되므로 다시 설정할 필요가 없습니다.
- **설치 및 업데이트**: 이 저장소의 [GitHub Releases](https://github.com/isdoge/obsidian-fast-note-sync/releases)를 통해서만 배포하며, Obsidian 커뮤니티 플러그인 스토어에는 등록하지 않습니다. 플러그인 내 원클릭 업그레이드는 이 저장소의 Releases에서 다운로드합니다. 새 버전 알림은 연결된 서버에서 전달되며, 이 저장소의 서버와 함께 사용할 때 이 저장소를 가리킵니다. Obsidian 자체의 「업데이트 확인」은 스토어의 업스트림 버전을 조회하므로 이 플러그인을 업데이트할 때는 사용하지 마세요.
- **연동 서버**: 마찬가지로 독립 유지보수되는 [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service)(v3.7.0 이상)와 함께 사용해 주세요. 일부 수정 사항은 플러그인과 서버를 모두 업그레이드해야 적용됩니다.
- **유지되는 항목**: 원저작자의 저작권 표시 및 후원 정보.
- **피드백**: 문제 제보나 기능 요청은 업스트림 저장소가 아닌 이 저장소의 [Issues](https://github.com/isdoge/obsidian-fast-note-sync/issues)에 등록해 주세요.

### 제거된 항목

독립 유지보수 버전에서는 아래 항목들이 제거되었습니다. **이 중 필요한 항목이 있다면 사용 환경을 적어 [issue를 등록](https://github.com/isdoge/obsidian-fast-note-sync/issues/new)해 알려주세요. 복구 여부를 검토하겠습니다.**

| 제거된 항목 | 설명 | 대체 방법 |
| --- | --- | --- |
| Obsidian 커뮤니티 플러그인 스토어를 통한 설치 | 이 저장소는 스토어에 등록하지 않습니다. 스토어에 있는 것은 업스트림 버전(v2.4.0에서 중단)입니다 | 이 저장소의 Releases에서 다운로드하여 덮어쓰기 설치한 뒤, 이후에는 플러그인 내장 업그레이드 기능 사용 |
| 텐센트 `cnb.cool` 미러 저장소 및 다운로드 소스 | 더 이상 cnb로 동기화하지 않습니다. 설정의 「플러그인 업데이트 소스」에는 GitHub만 남으며, 기존 설정의 cnb 값은 자동으로 GitHub로 처리됩니다 | GitHub Releases |

### 업스트림 버전에서 업그레이드

- 이 저장소의 Releases에서 `main.js`, `manifest.json`, `styles.css`(또는 zip 패키지)를 다운로드해 `.obsidian/plugins/fast-note-sync` 폴더의 같은 이름 파일에 덮어쓴 다음, Obsidian을 재시작하거나 플러그인을 다시 활성화하세요. 설정은 바꿀 필요가 없습니다.
- 서버도 함께 [isdoge/fast-note-sync-service](https://github.com/isdoge/fast-note-sync-service) v3.7.0 이상으로 업그레이드하는 것을 권장합니다.
- **동작 변경 사항**:
  - 다른 기기에서 삭제한 파일은 이제 Obsidian에 설정된 삭제 파일 처리 방식(시스템 휴지통 / Obsidian 휴지통 `.trash` / 영구 삭제)에 따라 처리됩니다. 영구 삭제로 설정된 경우 원격 삭제도 영구 삭제됩니다.
  - 읽기 전용 기기는 더 이상 서버에 로컬 디렉터리를 보고하지 않습니다.
  - 「해시 계산 수 제한」에 `0`을 입력하면 제한 없음을 의미합니다.
  - 업그레이드 전에 이미 1970년으로 표시된 파일 수정 시간은 자동으로 정정되지 않습니다. 표시에만 영향을 주며, 해당 파일이 다음에 수정되면 정상으로 돌아옵니다. 이를 고치기 위해 「로컬 파일을 삭제한 뒤 다시 받아오는」 방법은 사용하지 마세요. Obsidian에서 삭제하면 서버와 다른 기기에도 삭제가 동기화됩니다.


## ✨ 플러그인 기능

- 🚀 **극도로 단순한 설정**:
    - 번거로운 설정 없이 원격 서비스 구성을 붙여넣기만 하면 즉시 사용할 수 있습니다.
    - 또한 데스크톱 버전에서는 한 번의 클릭으로 구성을 가져와 자동으로 인증을 완료할 수도 있습니다.
    - 모바일에서 설정 붙여넣기에 실패하면 원인을 안내하며, JSON을 수동으로 붙여넣을 수 있습니다.
- 📗 **노트 실시간 동기화**:
    - Vault(보관소) 내의 모든 노트 생성, 업데이트 및 삭제 작업을 자동으로 감지하고 동기화합니다.
    - 다른 기기에서 삭제된 파일은 바로 영구 삭제하지 않고 Obsidian에 설정된 삭제 파일 처리 방식(시스템 휴지통 / Obsidian 휴지통 `.trash` / 영구 삭제)에 따라 처리됩니다.
- 🖼️ **첨부 파일 완벽 지원**:
    - 이미지, 비디오, 오디오 등 모든 비설정 파일을 실시간으로 동기화합니다.
    > ⚠️ **주의**: v1.0 이상, 서버 v0.9 이상이 필요합니다. 첨부 파일 크기를 적절하게 관리해 주세요. 파일이 크면 동기화 지연이 발생할 수 있습니다.
- ⚙️ **구성 동기화**:
    - 구성 동기화 기능을 제공하여 여러 기기 간의 구성 동기화를 지원합니다. 여러 기기에 수동으로 구성 파일을 복사하는 번거로움에서 벗어날 수 있습니다.
    - 플러그인 하위 디렉터리의 텍스트 리소스(예: 사전 파일) 동기화를 지원합니다.
    > ⚠️ **주의**: v1.4 이상, 서버 v1.0 이상이 필요합니다. 현재 테스트 단계이므로 주의하여 사용하세요.
- 🛂 **동기화 제외 및 화이트리스트**:
    - 동기화 제외 및 화이트리스트 기능을 제공하여 자신만의 동기화 전략을 지정할 수 있습니다.
- 🔄 **멀티 플랫폼 동기화**:
    - Mac, Windows, Android, iOS 등의 플랫폼을 지원합니다.
- 📝 **노트 기록**:
    - 노트 기록 기능을 제공하여 노트의 모든 과거 수정 내역을 자세히 확인할 수 있습니다.
    - 노트를 이전 버전으로 복구할 수 있습니다.
- 🛡️ **오프라인 노트 편집 자동 병합**:
    - 오프라인 기기에서 수행된 노트 수정 사항은 서버에 다시 연결될 때 자동으로 병합되어, 최신 업데이트만 유지함에 따른 데이터 손실을 방지합니다.
- 🚫 **오프라인 삭제 동기화 및 보완**:
    - 오프라인 중에 수행된 노트, 첨부 파일, 구성 삭제 작업은 다음 연결 시 서버로 자동 동기화되거나 서버에서 자동으로 보완됩니다.
- 🔍 **버전 감지**:
    - 버전 감지 기능을 제공하여 플러그인과 서버의 최신 버전 정보를 빠르게 확인하고 신속하게 업그레이드할 수 있습니다.
    - 원클릭 업그레이드는 이 저장소의 GitHub Releases에서 다운로드합니다.
- ☁️ **첨부 파일 클라우드 미리보기**:
    - 첨부 파일 온라인 미리보기 기능을 제공합니다. 첨부 파일을 로컬 기기에 동기화할 필요가 없어 로컬 저장 공간을 절약할 수 있습니다.
    > 플러그인의 제외 설정과 함께 사용하면, 특정 첨부 파일에 대해 서버를 거치지 않고 타사 저장소(예: WebDAV)를 직접 사용할 수 있습니다.
- 🗒️ **동기화 로그**:
    - 동기화 로그 기능을 제공하여 각 동기화의 상세 정보를 확인할 수 있습니다.
- **클라우드 스토리지 백업**: 클라우드 스토리지 백업 기능을 제공하여 노트 데이터가 유실되지 않도록 보호합니다.

## 🗺️ 로드맵 (Roadmap)

로드맵은 원저작자의 계획을 그대로 따릅니다. 독립 유지보수 버전에서는 이 목록에 따라 항목별로 차례대로 진행하며, 완료되는 대로 체크 표시를 해 나갈 예정입니다.
- [ ] **종단간 암호화**: 종단간 암호화 기능을 제공하여 노트 데이터가 어디에 저장되든 안전하게 보호되도록 합니다.
- [ ] **AI 노트**: AI+ 노트와 관련된 혁신적인 활용 방법을 모색하고 있습니다. 여러분의 소중한 제안을 기다립니다.

> **개선 제안이나 새로운 아이디어가 있다면 issue를 제출하여 공유해 주세요. 소중한 제안을 신중하게 검토하여 반영하겠습니다.**

## 💖 후원 및 지원

- 이 프로젝트는 HaierKeys님이 만들었습니다. 도움이 되셨다면 아래 방법을 통해 원저작자를 후원하실 수 있습니다(후원금은 원저작자에게 귀속되며 이 저장소의 유지보수와는 무관합니다):

  | Ko-fi *중국 이외 지역*                                                                                 |    | 위챗페이 *중국 지역*                                   |
  |--------------------------------------------------------------------------------------------------|----|------------------------------------------------|
  | [<img src="/docs/images/kofi.png" alt="BuyMeACoffee" height="150">](https://ko-fi.com/haierkeys) | or | <img src="/docs/images/wxds.png" height="150"> |

- 후원자 명단:
  - <a href="https://github.com/isdoge/fast-note-sync-service/blob/master/docs/Support.ko.md">Support.ko.md</a>


## 🚀 시작하기

**첫 번째 단계: 플러그인 받기**

* **수동 설치:** [GitHub 릴리스 페이지](https://github.com/isdoge/obsidian-fast-note-sync/releases)에서 `main.js`, `styles.css`, `manifest.json` 파일을 다운로드해 `.obsidian/plugins/fast-note-sync` 폴더에 넣은 다음, Obsidian의 커뮤니티 플러그인 목록에서 활성화하세요.
* **이미 업스트림 버전을 설치한 경우:** 위 세 파일로 같은 이름의 파일을 덮어쓰기만 하면 기존 설정이 그대로 유지됩니다.
* 이 플러그인은 Obsidian 커뮤니티 플러그인 스토어에 등록되어 있지 않으니 스토어에서 설치하지 마세요.

**두 번째 단계: 동기화 승인**

1. 구축한 **[Fast Note Sync Service](https://github.com/isdoge/fast-note-sync-service)** 웹 인터페이스에 접속합니다.
2. 왼쪽 내비게이션 바에서 **「노트 보관소」**를 선택합니다.
3. **「Obsidian 원클릭 승인」**을 클릭하면 시스템이 자동으로 Obsidian을 호출하고 승인 정보 전달을 완료합니다. 물론 수동으로 승인 정보를 플러그인에 복사할 수도 있습니다.

## 📦 서버 배포

백엔드 서버 설정은 다음을 참조하세요:
- <a href="https://github.com/isdoge/fast-note-sync-service">Fast Note Sync Service</a>
