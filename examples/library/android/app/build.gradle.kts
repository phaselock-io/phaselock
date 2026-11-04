// The app, with its two native parts built beside it: the native host, by cargo-ndk from
// client/kotlin/native for each ABI the app ships, and the model's native bundle, by the
// model's own scripts, which also regenerate the model's Kotlin.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val repo = rootDir.resolve("../../..").canonicalFile
val model = repo.resolve("examples/library/model")
val abis = listOf("arm64-v8a", "x86_64")

android {
    namespace = "io.phaselock.examples.library.android"
    compileSdk = 37
    ndkVersion = "30.0.16248370"

    defaultConfig {
        applicationId = "io.phaselock.examples.library"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.2.0"
        ndk { abiFilters += abis }
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets["main"].apply {
        kotlin.directories += model.resolve("kotlin").path
        assets.directories += layout.buildDirectory.dir("bundle").get().asFile.path
        jniLibs.directories += layout.buildDirectory.dir("jniLibs").get().asFile.path
    }
}

dependencies {
    implementation("io.phaselock:phaselock-client")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}

// the native host for each ABI, where the app's jniLibs are
val nativeHost = tasks.register<Exec>("nativeHost") {
    val out = layout.buildDirectory.dir("jniLibs").get().asFile
    val ndk = androidComponents.sdkComponents.ndkDirectory
    workingDir = repo.resolve("client/kotlin/native")
    doFirst { environment("ANDROID_NDK_HOME", ndk.get().asFile.path) }
    commandLine(
        listOf("cargo", "ndk", "-P", "26", "-o", out.path) + abis.flatMap { listOf("-t", it) } +
            listOf("build", "--release"),
    )
}

// the model's generated code and its native bundle, the app's one asset
val nativeBundle = tasks.register<Exec>("nativeBundle") {
    workingDir = model
    commandLine("sh", "-c", "pnpm gen && pnpm bundle:native")
    doLast {
        val out = layout.buildDirectory.dir("bundle").get().asFile
        out.mkdirs()
        model.resolve("native.bundle.js").copyTo(out.resolve("native.bundle.js"), overwrite = true)
    }
}

tasks.named("preBuild") { dependsOn(nativeHost, nativeBundle) }
