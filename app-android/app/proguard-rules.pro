# R8 裁剪规则
#
# 原模板开了 minifyEnabled 却没有这个文件，等于让 R8 按空配置跑。
# 对普通 Activity 尚且无碍（清单里声明过的组件 AGP 会自动保留），
# 但下面这类「没有静态调用点」的代码 R8 是看不见的，必须显式保住。

# WebView 的 JS 接口：由 JS 侧按方法名反射调用，Java 这边一个调用点都没有。
# 被裁掉或改名的话，页面上的检查更新、装新包会静默失效——而且只在 release 包里发作。
-keepclassmembers class org.foyue.wenchao.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes *Annotation*

# 行号保留：崩溃栈没有行号就只能靠猜
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
