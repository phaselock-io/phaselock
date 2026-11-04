// PhaseLock's colors, as the web demo and phaselock.io use them: a near-neutral dark ground and
// text, and phosphor green as the one accent.

package io.phaselock.examples.library.android

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver

object Palette {
    val ground = Color(0xFF0B0F0D)
    val panel = Color(0xFF18221E)
    val border = Color(0xFF2C3A33)
    val text = Color(0xFFE8ECE9)
    val muted = Color(0xFF8A9A92)
    val accent = Color(0xFF2EE6A8)
    val onAccent = Color(0xFF0A1F18)
    val amber = Color(0xFFF2D98C)
    val alarm = Color(0xFFE5786D)
}

/** a color from the #rrggbb a patron's record holds, or muted gray for anything else */
fun colorOf(hex: String): Color =
    hex.removePrefix("#").toLongOrNull(16)?.takeIf { hex.length == 7 }?.let { Color(0xFF000000 or it) } ?: Palette.muted

@Composable
fun LibraryTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Palette.accent,
            onPrimary = Palette.onAccent,
            secondary = Palette.accent,
            secondaryContainer = Palette.accent.copy(alpha = 0.16f).compositeOver(Palette.panel),
            onSecondaryContainer = Palette.accent,
            background = Palette.ground,
            onBackground = Palette.text,
            surface = Palette.panel,
            onSurface = Palette.text,
            surfaceVariant = Palette.panel,
            onSurfaceVariant = Palette.muted,
            outline = Palette.border,
            error = Palette.alarm,
        ),
        content = content,
    )
}
