// UI text for closed-lid mode, Korean. Keys start with "lid.".
// `lid.status.<status>` covers every C3 `closedLid.status`; `lid.block.<reason>` covers every block
// reason of C10 (the C3 `closedLid.blocked` values plus `external` and `unavailable`).

export default {
  "lid.status.off": "꺼짐",
  "lid.status.engaged": "켜짐",
  "lid.status.blocked": "일시 중지됨",
  "lid.status.unavailable": "사용할 수 없음",
  "lid.status.external": "다른 앱이 설정함",
  "lid.waiting": "Mac을 깨어 있게 하는 동안 켜집니다",
  "lid.paused": "일시 중지됨: {reason}",
  "lid.block.ac": "배터리로 작동 중 (전원 어댑터에 연결된 경우에만 켜짐)",
  "lid.block.battery": "배터리 {floor}% 미만",
  "lid.block.thermal": "Mac 온도가 높음",
  "lid.block.unknown": "전원 상태를 읽을 수 없음",
  "lid.block.other-instance": "다른 Herdr가 사용 중",
  "lid.block.external": "다른 앱이 이미 잠자기를 막고 있음",
  "lid.block.unavailable": "잠자기 설정을 바꿀 수 없음",
};
