// The app, with its two native parts built beside it: the native host, by cargo-ndk from its JNI
// binding in client/kotlin/native for each ABI the app ships, and the model's native bundle, by the
// model's own scripts, which also regenerate the model's Kotlin.  A debug APK's bundle runs the
// skeleton in development mode, and a release APK's in production.

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
        jniLibs.directories += layout.buildDirectory.dir("jniLibs").get().asFile.path
    }

    // each build type's native bundle, under the one name the app opens
    for (type in listOf("debug", "release")) {
        val bundle = layout.buildDirectory.dir("bundle/$type").get().asFile
        sourceSets[type].assets.directories += bundle.path
    }
}

// the model's classes as stable, and the compiler's stability reports, written to
// build/compose_compiler by a build run with -PcomposeReports
composeCompiler {
    stabilityConfigurationFiles.add(layout.projectDirectory.file("compose_compiler_config.conf"))
    if (providers.gradleProperty("composeReports").isPresent) {
        reportsDestination = layout.buildDirectory.dir("compose_compiler")
        metricsDestination = layout.buildDirectory.dir("compose_compiler")
    }
}

dependencies {
    implementation("io.phaselock:phaselock-client")
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.datastore:datastore-preferences:1.3.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-process:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
}

// the native host for each ABI, where the app's jniLibs are, built from the JNI binding and the
// shared native host and Rust core beneath it
val nativeHost = tasks.register<Exec>("nativeHost") {
    val out = layout.buildDirectory.dir("jniLibs").get().asFile
    val ndk = androidComponents.sdkComponents.ndkDirectory
    workingDir = repo.resolve("client/kotlin/native")
    for (crate in listOf("client/kotlin/native", "client/native", "core")) {
        inputs.files(fileTree(repo.resolve(crate)) { exclude("target/**") })
    }
    outputs.dir(out)
    doFirst { environment("ANDROID_NDK_HOME", ndk.get().asFile.path) }
    commandLine(
        listOf("cargo", "ndk", "-P", "26", "-o", out.path) + abis.flatMap { listOf("-t", it) } +
            listOf("build", "--release"),
    )
}

// the model's generated code and its native bundles, the app's one asset: the development bundle
// for debug and the production bundle for release, each as native.bundle.js.  They come from the
// model's sources, the plugins it installs, and the emitters and skeleton that generate it.
val nativeBundle = tasks.register<Exec>("nativeBundle") {
    val out = layout.buildDirectory.dir("bundle").get().asFile
    workingDir = model
    inputs.files(fileTree(model) { include("*.tsp", "*.ts", "*.json", "*.yaml"); exclude("*.gen.ts") })
    val tooling = listOf(
        "plugins/src", "typespec/core/src", "typespec/core/lib",
        "typespec/ts/src", "typespec/ts/assets", "typespec/kt/src",
    )
    for (dir in tooling) inputs.dir(repo.resolve(dir))
    outputs.files(model.resolve("model.gen.ts"), model.resolve("native.bundle.js"), model.resolve("native.dev.bundle.js"))
    outputs.dir(model.resolve("kotlin"))
    outputs.dir(out)
    commandLine("sh", "-c", "pnpm gen && pnpm bundle:native:dev && pnpm bundle:native")
    doLast {
        val bundles = mapOf("debug" to "native.dev.bundle.js", "release" to "native.bundle.js")
        for ((type, file) in bundles) {
            model.resolve(file).copyTo(out.resolve("$type/native.bundle.js"), overwrite = true)
        }
    }
}

tasks.named("preBuild") { dependsOn(nativeHost, nativeBundle) }
