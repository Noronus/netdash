import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// the app has the netdash version: NETDASH_VERSION from the release workflow (git tag), else VERSION in backend/main.py
val appVersion: String = System.getenv("NETDASH_VERSION")?.takeIf { it.isNotBlank() }
    ?: Regex("""(?m)^VERSION = "(.+)"""").find(rootProject.file("../backend/main.py").readText())!!.groupValues[1]
val appVersionCode = appVersion.split(".").map { it.toInt() }.let { (a, b, c) -> a * 10000 + b * 100 + c }

// release signing comes from the environment (CI secrets or a local shell), never from the repository
val keystore: String? = System.getenv("NETDASH_KEYSTORE")

android {
    namespace = "io.github.noronus.netdash"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.noronus.netdash"
        minSdk = 29
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersion
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("NETDASH_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("NETDASH_KEY_ALIAS") ?: "netdash"
                keyPassword = System.getenv("NETDASH_KEY_PASSWORD") ?: System.getenv("NETDASH_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    // no Google-encrypted dependency blob in the APK (it only matters for Play)
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

base {
    archivesName.set("netdash-android-$appVersion")
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.google.android.material:material:1.12.0")
}
