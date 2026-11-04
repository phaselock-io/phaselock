// @phaselock/client's Kotlin counterpart: the transport over HTTP, sessions, msgpack, the Kotlin
// walk of the generated type registry, and the host that runs the Engine in QuickJS through the
// native library built from native/.  A plain JVM library, so an Android app and a JVM test use
// the same jar.

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.4.21"
    `java-library`
}

group = "io.phaselock"
version = "0.2.0"

repositories {
    mavenCentral()
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    api("com.squareup.okhttp3:okhttp:5.5.1")
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
}

// bytecode Android's toolchain takes, from the JDK the build runs on
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

// the native library for this machine, which the tests load, built from the native crate and the
// shared Rust crate beneath it
val repo = rootDir.resolve("../..").canonicalFile
val cargoBuild = tasks.register<Exec>("cargoBuild") {
    workingDir = rootDir.resolve("native")
    for (crate in listOf("client/kotlin/native", "core")) {
        inputs.files(fileTree(repo.resolve(crate)) { exclude("target/**") })
    }
    outputs.files(fileTree(rootDir.resolve("native/target/release")) { include("libphaselock_jni.*") })
    commandLine("cargo", "build", "--release")
}

// the bundles the integration tests run: the library example's database bundle, and its native
// bundle in development mode, from the model's sources, the plugins it installs, and the emitters
// and skeleton that generate it
val libraryBundles = tasks.register<Exec>("libraryBundles") {
    val model = repo.resolve("examples/library/model")
    workingDir = model
    inputs.files(fileTree(model) { include("*.tsp", "*.ts", "*.json", "*.yaml"); exclude("*.gen.ts") })
    val tooling = listOf(
        "plugins/src", "typespec/core/src", "typespec/core/lib",
        "typespec/ts/src", "typespec/ts/assets", "typespec/kt/src",
    )
    for (dir in tooling) inputs.dir(repo.resolve(dir))
    outputs.files(model.resolve("model.gen.ts"), model.resolve("bundle.js"), model.resolve("native.dev.bundle.js"))
    outputs.dir(model.resolve("kotlin"))
    commandLine("sh", "-c", "pnpm gen && pnpm bundle && pnpm bundle:native:dev")
}

// the library example's generated Kotlin, which the integration tests drive
sourceSets.test { kotlin.srcDir(repo.resolve("examples/library/model/kotlin")) }
tasks.compileTestKotlin { dependsOn(libraryBundles) }

tasks.test {
    useJUnitPlatform()
    dependsOn(cargoBuild, libraryBundles)
    systemProperty("java.library.path", rootDir.resolve("native/target/release").path)
    // a rebuilt native library runs the tests again
    inputs.files(fileTree(rootDir.resolve("native/target/release")) { include("libphaselock_jni.*") })
    systemProperty("phaselock.repo", repo.path)
    testLogging {
        events("passed", "failed")
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
