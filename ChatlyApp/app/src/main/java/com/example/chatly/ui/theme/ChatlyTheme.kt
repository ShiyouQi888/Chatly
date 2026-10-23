package com.example.chatly.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// CDLS v1.0 Full Brand Color Scale (Chatly Violet)
val ChatlyBrand50 = Color(0xFFF3F1FE)
val ChatlyBrand100 = Color(0xFFE6E2FD)
val ChatlyBrand200 = Color(0xFFCCC5FB)
val ChatlyBrand300 = Color(0xFFA99EF5)
val ChatlyBrand400 = Color(0xFF8B7CF6)
val ChatlyBrand500 = Color(0xFF6D5DF6) // Brand Identification
val ChatlyBrand600 = Color(0xFF5B4BD8) // Main Action
val ChatlyBrand700 = Color(0xFF4A3CB0)
val ChatlyBrand800 = Color(0xFF392E88)
val ChatlyBrand900 = Color(0xFF2A2166)

val ChatlyViolet = ChatlyBrand500
val ChatlyAction = ChatlyBrand600

// Neutral Surfaces (Cold Gray with Violet Tint)
val ChatlyBg = Color(0xFFF6F6FA)
val ChatlyBg2 = Color(0xFFFBFBFE)
val ChatlySurface = Color(0xFFFFFFFF)
val ChatlySurface2 = Color(0xFFF0F0F7)
val ChatlySurface3 = Color(0xFFE8E8F2)
val ChatlyLine = Color(0x1417171F)
val ChatlyLineStrong = Color(0x2417171F)
val ChatlyMask = Color(0x7A111118)

// Text Hierarchy (All WCAG AA Compliant)
val ChatlyText1 = Color(0xFF17171F)
val ChatlyText2 = Color(0xFF4A4A5A)
val ChatlyText3 = Color(0xFF6B6B82)
val ChatlyTextMuted = Color(0xFF6B6B82)
val ChatlyTextDisabled = Color(0xFF6B6B82)

// Semantics
val ChatlyDanger = Color(0xFFC62F42)
val ChatlySuccess = Color(0xFF1E9E6A)
val ChatlyWarning = Color(0xFFB26B00)
val ChatlyInfo = Color(0xFF2563A8)
val ChatlyLink = Color(0xFF4A5A9E)

// Squircle radius calculation: size / 3 (e.g., 48dp -> 16dp radius)
fun squircleCornerRadius(size: Dp): Dp = size / 3
fun squircleShape(size: Dp) = RoundedCornerShape(squircleCornerRadius(size))

private val LightColorScheme = lightColorScheme(
    primary = ChatlyBrand500,
    onPrimary = Color.White,
    primaryContainer = ChatlyBrand50,
    onPrimaryContainer = ChatlyBrand900,
    secondary = ChatlyBrand600,
    onSecondary = Color.White,
    background = ChatlyBg,
    onBackground = ChatlyText1,
    surface = ChatlySurface,
    onSurface = ChatlyText1,
    surfaceVariant = ChatlySurface2,
    onSurfaceVariant = ChatlyText2,
    error = ChatlyDanger,
    onError = Color.White
)

private val DarkColorScheme = darkColorScheme(
    primary = ChatlyBrand300,
    onPrimary = ChatlyBrand900,
    background = Color(0xFF121218),
    onBackground = Color(0xFFF6F6FA),
    surface = Color(0xFF1C1C24),
    onSurface = Color(0xFFF6F6FA),
    surfaceVariant = Color(0xFF2A2A36),
    onSurfaceVariant = Color(0xFF9A9AB0),
    error = Color(0xFFE53E5D),
    onError = Color.White
)

@Composable
fun ChatlyTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme

    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}
