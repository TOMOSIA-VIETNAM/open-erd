from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.db import models


class UserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra):
        user = self.model(email=self.normalize_email(email), **extra)
        user.set_password(password)
        user.save()
        return user


class User(AbstractBaseUser):
    class Role(models.TextChoices):
        ADMIN = "admin", "Administrator"
        DOCTOR = "doctor", "Doctor"
        NURSE = "nurse", "Nurse"
        RECEPTION = "reception", "Front desk"

    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=120)
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.RECEPTION)
    is_active = models.BooleanField(default=True)
    date_joined = models.DateTimeField(auto_now_add=True)

    USERNAME_FIELD = "email"
    objects = UserManager()


class Team(models.Model):
    name = models.CharField(max_length=80)
    # Departments nest: "Surgery" > "Orthopedics".
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.CASCADE, related_name="children")


class StaffProfile(models.Model):
    user = models.OneToOneField("accounts.User", on_delete=models.CASCADE, related_name="staff_profile")
    license_number = models.CharField(max_length=32, unique=True)
    phone = models.CharField(max_length=20, blank=True)
    teams = models.ManyToManyField(Team, related_name="members")
