// Brillo aditivo sin iluminación (URP). Sirve para luces, rayos, anillos y partículas de los efectos épicos.
Shader "TinTech/EpicAdditive"
{
    Properties
    {
        _MainTex ("Textura", 2D) = "white" {}
        _Color ("Color", Color) = (1,1,1,1)
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "RenderPipeline"="UniversalPipeline" "IgnoreProjector"="True" }
        Blend SrcAlpha One
        ZWrite Off
        Cull Off
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attr { float4 pos : POSITION; float2 uv : TEXCOORD0; float4 col : COLOR; };
            struct Vary { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float4 col : COLOR; };

            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                half4 _Color;
            CBUFFER_END

            Vary vert (Attr a)
            {
                Vary v;
                v.pos = TransformObjectToHClip(a.pos.xyz);
                v.uv = TRANSFORM_TEX(a.uv, _MainTex);
                v.col = a.col;
                return v;
            }

            half4 frag (Vary v) : SV_Target
            {
                half4 t = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, v.uv);
                return t * _Color * v.col;
            }
            ENDHLSL
        }
    }
}
