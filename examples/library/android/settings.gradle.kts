// The library example's Android app.  It builds against the Kotlin client in client/kotlin,
// included as a build of its own, and the model's generated Kotlin.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "library-android"
include(":app")
includeBuild("../../../client/kotlin")
