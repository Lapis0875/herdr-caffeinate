// UI text for errors shown to the owner, Korean. Keys start with "error.".
// `{detail}` is the program's own message; `{script}` is `install.sh` or `uninstall.sh`.

export default {
  "error.timer.range": "분을 {min}~{max} 사이의 정수로 입력하세요",
  "error.settings.read": "settings.json을 읽지 못해 기본값을 사용합니다",
  "error.settings.save": "설정을 저장하지 못했습니다: {detail}",
  "error.holder": "caffeinate를 시작하지 못했습니다: {detail}",
  "error.lid.engage": "덮개 닫힘 모드를 켜지 못했습니다. 잠자기 설정이 바뀌지 않았습니다",
  "error.lid.restore": "잠자기를 다시 켜지 못했습니다. 터미널에서 실행하세요: sudo pmset -a disablesleep 0",
  "error.tab": "{script} 실행용 탭을 열지 못했습니다",
};
