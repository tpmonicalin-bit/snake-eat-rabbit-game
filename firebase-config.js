// 把你在 Firebase 控制台里拿到的 Web App config 贴在下面，替换掉这几个占位值。
// 步骤：
// 1. https://console.firebase.google.com 新建项目
// 2. 左侧菜单开启 "Realtime Database"（先选测试模式规则）
// 3. 项目设置 -> 你的应用 -> 添加 Web 应用，复制这段 config
const firebaseConfig = {
  apiKey: "AIzaSyBu805-GVmny-jKKB3ZE7N-xDXdjRermlM",
  authDomain: "snake-eat-rabbit.firebaseapp.com",
  databaseURL: "https://snake-eat-rabbit-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "snake-eat-rabbit",
  storageBucket: "snake-eat-rabbit.firebasestorage.app",
  messagingSenderId: "287532762335",
  appId: "1:287532762335:web:088f57714b33c0ccfc956a",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
